#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fleetLogin } = require('./fleet-identity.cjs');
const { isDispatch } = require('./worker-hook-bridge.cjs');
const review = require('./worker-review.cjs');

const decision = (permissionDecision, permissionDecisionReason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision,
    ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
  },
});

// Setup validates and binds the trusted dispatch inputs once. This normalized
// record must never be constructed from issue text, labels or a worker reply.
function prepareContext(brief, identity) {
  const { runId, attemptId, provider } = identity;
  if (
    !['claude', 'codex', 'opencode'].includes(provider) ||
    typeof runId !== 'string' ||
    typeof attemptId !== 'string'
  )
    throw new Error('Invalid worker identity');
  const generation = runId.match(/\/r([1-9][0-9]*)$/)?.[1];
  if (
    !generation ||
    !Number.isSafeInteger(Number(generation)) ||
    attemptId !== `g${generation}:${runId}`
  )
    throw new Error('Attempt/run identity mismatch');
  if (
    !brief ||
    !['implement', 'review', 'reply'].includes(brief.mode) ||
    typeof brief.repository !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(brief.repository)
  ) {
    throw new Error('Invalid dispatch mode or repository');
  }
  const anchor = brief.anchor;
  if (!anchor || !['issue', 'pull-request', 'work'].includes(anchor.type))
    throw new Error('Invalid anchor');
  if (anchor.type === 'work') {
    if (
      typeof anchor.id !== 'string' ||
      !anchor.id ||
      runId !== `work:${anchor.id}/r${generation}` ||
      brief.mode !== 'implement'
    ) {
      throw new Error('Invalid native Work binding');
    }
  } else if (
    !Number.isSafeInteger(anchor.number) ||
    anchor.number < 1 ||
    runId !== `${brief.repository}#${anchor.number}/r${generation}` ||
    (brief.mode === 'review' && anchor.type !== 'pull-request')
  ) {
    throw new Error('Invalid GitHub anchor binding');
  }
  return {
    policyVersion: 1,
    runId,
    attemptId,
    provider,
    repository: brief.repository,
    mode: brief.mode,
    anchor: {
      type: anchor.type,
      number: anchor.number ?? null,
      id: anchor.id ?? null,
    },
  };
}

// Deliberately limited literal shell grammar: quotes/escapes and command lists.
// Expansion, pipelines, redirection, substitutions and scripts are not treated
// as equivalent to parsed commands. The documented interception coverage is
// not an assertion of a shell sandbox or a credential boundary.
function literalCommands(source) {
  if (typeof source !== 'string') return null;
  const commands = [],
    words = [];
  let word = '',
    started = false,
    quote = null;
  const flush = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  const end = () => {
    flush();
    if (words.length) commands.push(words.splice(0));
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === '\\') {
      if (i + 1 === source.length) return null;
      const next = source[++i];
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next))
        word += '\\';
      if (next !== '\n') {
        word += next;
        started = true;
      }
      continue;
    }
    if (char === '$' || char === '`') return null;
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (
      char === ';' ||
      char === '\n' ||
      source.slice(i, i + 2) === '&&' ||
      source.slice(i, i + 2) === '||'
    ) {
      if (char === '&' || char === '|') i++;
      end();
      continue;
    }
    if ('|&<>(){}*?[]~'.includes(char)) return null;
    if (char === '#' && !started) {
      while (i < source.length && source[i] !== '\n') i++;
      end();
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    word += char;
    started = true;
  }
  if (quote) return null;
  end();
  return commands;
}

function operations(input) {
  const name = input.tool_name;
  const args = input.tool_input ?? {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (
    [
      'Edit',
      'Write',
      'MultiEdit',
      'apply_patch',
      'edit',
      'write',
      'multiedit',
    ].includes(name)
  ) {
    const file = args.file_path ?? args.filePath;
    return [
      {
        kind: 'implementation',
        cwd:
          typeof file === 'string'
            ? path.dirname(path.resolve(cwd, file))
            : cwd,
      },
    ];
  }
  if (!['Bash', 'exec_command', 'shell_command', 'bash'].includes(name))
    return [];
  const commands = literalCommands(args.command ?? args.cmd);
  if (!commands) return [];
  let directory =
    typeof args.workdir === 'string' ? path.resolve(cwd, args.workdir) : cwd;
  const result = [];
  for (const original of commands) {
    const words = [...original];
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (words[0] === 'command') words.shift();
    const executable = path.basename(words.shift() ?? '');
    if (executable === 'cd') {
      if (words.length !== 1 || words[0] === '-' || words[0].startsWith('~'))
        return result;
      directory = path.resolve(directory, words[0]);
      continue;
    }
    if (executable === 'git') {
      let gitCwd = directory;
      while (words[0] === '-C') {
        words.shift();
        if (!words[0]) return result;
        gitCwd = path.resolve(gitCwd, words.shift());
      }
      const verb = words[0];
      if (
        [
          'add',
          'commit',
          'push',
          'apply',
          'am',
          'cherry-pick',
          'merge',
          'rebase',
          'reset',
          'checkout',
          'switch',
          'stash',
          'restore',
          'clean',
        ].includes(verb)
      ) {
        result.push({
          kind: verb === 'push' ? 'publication' : 'implementation',
          cwd: gitCwd,
          unsafe:
            words.includes('--no-verify') ||
            (verb === 'push' &&
              (words.includes('--force') || words.includes('-f'))),
        });
      }
    }
    if (executable === 'gh') {
      const [resource, verb] = words;
      if (resource === 'pr' && ['create', 'ready', 'merge'].includes(verb)) {
        if (
          (verb === 'ready' && words.includes('--undo')) ||
          (verb === 'merge' &&
            words.includes('--disable-auto') &&
            !words.includes('--auto') &&
            !words.includes('-a'))
        )
          continue;
        result.push({
          kind: verb === 'create' ? 'publication' : 'ready',
          cwd: directory,
          args: words.slice(2),
        });
      }
      if (
        (['pr', 'issue'].includes(resource) && verb === 'comment') ||
        (resource === 'pr' && verb === 'review')
      )
        result.push({ kind: 'artifact', cwd: directory });
    }
  }
  return result;
}

function assertWorktree(directory) {
  // New files may have parents that do not exist yet. Resolve the closest
  // existing parent so the authoritative repo-tools guard sees the real repo.
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('No worktree ancestor');
    directory = parent;
  }
  execFileSync('repo-require-worktree', ['worker mutations'], {
    cwd: directory,
    timeout: 1000,
    stdio: ['ignore', 'ignore', 'ignore'],
    // Direct workers are not Actions jobs. Do not let the shared guard's
    // hosted-Actions exemption weaken this explicit dispatched-worker path.
    env: { ...process.env, GITHUB_ACTIONS: 'false' },
  });
}

function readOwnership(context) {
  return JSON.parse(
    execFileSync(
      'gh',
      ['api', `repos/${context.repository}/issues/${context.anchor.number}`],
      {
        timeout: 2000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1024 * 1024,
      },
    ),
  );
}

// Repair only newly created, explicitly scoped deliverables. Never stamp an
// existing object, infer a target from a branch, or edit a worker's body file.
function repairArtifact(input, context, dependencies = {}) {
  if (input.tool_name !== 'Bash') return null;
  const commands = literalCommands(input.tool_input?.command);
  if (!commands || commands.length !== 1) return null;
  const words = commands[0];
  if (path.basename(words[0] ?? '') !== 'gh') return null;
  const [resource, verb] = words.slice(1);
  if (!(
    (resource === 'pr' && ['create', 'comment', 'review'].includes(verb)) ||
    (resource === 'issue' && verb === 'comment')
  ))
    return null;
  const args = words.slice(3);
  const positional = [];
  const flags = new Map();
  const switches = new Set(
    verb === 'review'
      ? ['--approve', '-a', '--request-changes', '-r', '--comment', '-c']
      : ['--draft', '-d'],
  );
  const values = new Set([
    '--repo',
    '-R',
    '--body',
    '-b',
    '--body-file',
    '-F',
    '--title',
    '-t',
    '--base',
    '-B',
    '--head',
    '-H',
    '--label',
    '-l',
    '--assignee',
    '--reviewer',
    '--milestone',
    '--project',
    ...(verb === 'create' ? ['-a', '-r'] : []),
  ]);
  const retained = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (switches.has(arg)) {
      retained.push(arg);
      continue;
    }
    const equal = arg.indexOf('=');
    const flag = equal > 0 ? arg.slice(0, equal) : arg;
    if (values.has(flag)) {
      const value = equal > 0 ? arg.slice(equal + 1) : args[++i];
      if (value === undefined || flags.has(flag))
        throw new Error('Ambiguous artifact arguments');
      flags.set(flag, value);
      if (!['--body', '-b', '--body-file', '-F'].includes(flag))
        retained.push(flag, value);
    } else if (arg.startsWith('-')) {
      // Includes edit-last/delete-last, fill/editor, web and inherited flags
      // whose publication semantics have not been qualified.
      throw new Error('Unsupported artifact flag');
    } else {
      positional.push(arg);
      retained.push(arg);
    }
  }
  const repositories = ['--repo', '-R'].filter((flag) => flags.has(flag));
  if (repositories.length > 1) throw new Error('Ambiguous repository');
  const repository = repositories.length
    ? flags.get(repositories[0])
    : (
        dependencies.readRepository ??
        ((cwd) =>
          execFileSync(
            'gh',
            [
              'repo',
              'view',
              '--json',
              'nameWithOwner',
              '--jq',
              '.nameWithOwner',
            ],
            {
              cwd,
              timeout: 2000,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            },
          ).trim())
      )(input.cwd ?? process.cwd());
  if (repository.toLowerCase() !== context.repository.toLowerCase())
    return null;
  if (verb === 'create') {
    if (context.mode === 'review' || positional.length)
      throw new Error('Invalid PR creation for dispatch');
  } else {
    if (
      context.anchor.type === 'work' ||
      positional.length !== 1 ||
      positional[0] !== String(context.anchor.number)
    )
      return null;
    if (resource === 'issue' && context.anchor.type !== 'issue') return null;
    if (resource === 'pr' && context.anchor.type !== 'pull-request')
      return null;
  }
  const bodies = ['--body', '-b', '--body-file', '-F'].filter((flag) =>
    flags.has(flag),
  );
  if (bodies.length !== 1) throw new Error('Use one explicit artifact body');
  const bodyFlag = bodies[0];
  let body = flags.get(bodyFlag);
  if (['--body-file', '-F'].includes(bodyFlag)) {
    if (body === '-')
      throw new Error('Streaming artifact bodies require an explicit file');
    const file = path.resolve(input.cwd ?? process.cwd(), body);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 65536)
      throw new Error('Invalid artifact body file');
    body = fs.readFileSync(file, 'utf8');
  }
  const marker = `<!-- attempt-claim:${context.attemptId} -->`;
  // Foreign claims require explicit reconciliation, not relabeling authorship.
  const claims = body.match(/<!--\s*attempt-claim:[\s\S]*?-->/g) ?? [];
  if (claims.some((claim) => claim !== marker))
    throw new Error('Foreign attempt marker');
  if (body.includes(marker)) return null;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    command: [
      words[0],
      resource,
      verb,
      ...retained,
      '--body',
      `${body}\n\n${marker}`,
    ]
      .map(quote)
      .join(' '),
  };
}

function evaluate(input, context, dependencies = {}) {
  const ops = operations(input);
  let repaired;
  try {
    repaired = repairArtifact(input, context, dependencies);
  } catch {
    return decision(
      'deny',
      'Deliverable marker repair needs one explicit body and an unambiguous dispatch target. Preserve the content, use --body or a regular --body-file, and reconcile foreign attempt markers before retrying.',
    );
  }
  if (!ops.length && !repaired) return decision('allow');
  if (context.mode === 'review' && ops.some((op) => op.kind !== 'artifact'))
    return decision(
      'deny',
      'This dispatch requests review, not implementation or publication. Submit the review without modifying or pushing code.',
    );
  if (ops.some((op) => op.unsafe))
    return decision(
      'deny',
      'Do not bypass Git hooks or use an unleased force push.',
    );
  try {
    for (const directory of new Set(
      ops.filter((op) => op.kind !== 'artifact').map((op) => op.cwd),
    ))
      (dependencies.assertWorktree ?? assertWorktree)(directory);
  } catch {
    return decision(
      'deny',
      'Implementation and publication require a feature worktree. Create or enter the task worktree; leave the primary checkout untouched.',
    );
  }
  if (context.anchor.type !== 'work') {
    let issue;
    try {
      issue = (dependencies.readOwnership ?? readOwnership)(context);
    } catch {
      return decision(
        'deny',
        'Current anchor ownership could not be verified. Retry the read after recovery; do not publish on uncertain ownership.',
      );
    }
    if (
      issue.state !== 'open' ||
      !Array.isArray(issue.assignees) ||
      !issue.assignees.some((assignee) => assignee.login === fleetLogin())
    ) {
      return decision(
        'deny',
        'The anchor is closed or no longer claimed by the fleet. Reconcile current ownership and already-delivered work before implementing or publishing.',
      );
    }
  }
  const allowed = decision('allow');
  for (const op of ops.filter((operation) => operation.kind === 'ready')) {
    // Explicit targets keep readiness evidence bound to the actual operation.
    // Branch/default selection must first be resolved by the worker.
    let target;
    try {
      target = review.target(op.args, context.repository);
    } catch {
      return decision(
        'deny',
        'Use an explicit PR number and --repo for the dispatch repository, without --admin, so readiness can be checked against the correct PR.',
      );
    }
    try {
      const snapshot = (dependencies.readReviewSnapshot ?? review.readSnapshot)(
        target.repository,
        target.number,
      );
      const reason = review.rejection(snapshot);
      if (reason) return decision('deny', reason);
    } catch {
      return decision(
        'deny',
        'Current review and hold evidence could not be fully read. Retry the lookup after recovery; do not mark ready or arm merge on incomplete feedback.',
      );
    }
  }
  if (repaired) allowed.hookSpecificOutput.updatedInput = repaired;
  return allowed;
}

if (require.main === module && isDispatch(process.env)) {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const context = JSON.parse(
    fs.readFileSync(process.env.LCARS_WORKER_CONTEXT, 'utf8'),
  );
  process.stdout.write(`${JSON.stringify(evaluate(input, context))}\n`);
}

module.exports = {
  prepareContext,
  literalCommands,
  operations,
  repairArtifact,
  evaluate,
};
