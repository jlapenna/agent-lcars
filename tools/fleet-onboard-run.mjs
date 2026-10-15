#!/usr/bin/env node
// One command for the whole fleet onboarding sequence. It drives the three
// repository changes (target scaffold, Agent LCARS admission, Homelab
// admission) as draft pull requests and then runs the GitHub-side helper.
// Each step is idempotent and resumable: an existing pull request for the
// step's branch means the step is already done. The only steps it cannot
// perform are the ones GitHub and Homelab reserve for a human: adding the
// repository to the two App installations and the reviewed Terraform apply.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { dependencyInstallArgs } from './fleet-onboard.mjs';

export const STEPS = Object.freeze(['target', 'lcars', 'homelab', 'github']);
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const LCARS_REPO = 'jlapenna/agent-lcars';
const HOMELAB_REPO = 'jlapenna/homelab';
const REVIEWER = 'jlapenna';
const ATTRIBUTION =
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

export class RunError extends Error {}

function parseRepo(value, flag = '--repo') {
  if (!value || !REPO_PATTERN.test(value))
    throw new RunError(`${flag} must be OWNER/NAME, got ${value ?? ''}`);
  const [owner, name] = value.split('/');
  return { full: value, owner, name };
}

/** Default executor: run a program with an argument array, never a shell. */
export function createExec(spawn = spawnSync) {
  return (command, args, { cwd, input } = {}) => {
    const result = spawn(command, args, {
      cwd,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw new RunError(`${command} failed to start`);
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

/**
 * Wraps an executor so mutating commands are recorded instead of run while
 * dry-run is on. Read-only commands (listing pull requests, inspecting
 * refs) still run so the plan reflects the real state.
 */
export function createRunner({ exec, dryRun, log }) {
  const run = (command, args, options = {}) => {
    const { mutate = false, cwd, input, allowFailure = false } = options;
    const label = [command, ...args].join(' ');
    if (mutate && dryRun) {
      log(`would-run\t${cwd ?? '.'}\t${label}`);
      return { status: 0, stdout: '', stderr: '', skipped: true };
    }
    const result = exec(command, args, { cwd, input });
    if (result.status !== 0 && !allowFailure)
      throw new RunError(
        `${label} exited ${result.status}${
          result.stderr ? `: ${result.stderr.trim().split('\n').at(-1)}` : ''
        }`,
      );
    return result;
  };
  run.dryRun = dryRun;
  return run;
}

export function openPullRequest(run, repo, branch) {
  const result = run('gh', [
    'pr',
    'list',
    '-R',
    repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,url,isDraft',
  ]);
  const rows = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return rows[0] ?? null;
}

function defaultBranch(run, repo) {
  const result = run('gh', [
    'repo',
    'view',
    repo,
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ]);
  return result.stdout.trim() || 'main';
}

function commitAndPush(run, cwd, { branch, message, paths, all = false }) {
  // `-A` is an option, so it must precede `--`; a pathspec list goes after.
  run('git', all ? ['add', '-A'] : ['add', '--', ...paths], {
    cwd,
    mutate: true,
  });
  const staged = run('git', ['diff', '--cached', '--quiet'], {
    cwd,
    allowFailure: true,
  });
  if (staged.status === 0 && !staged.skipped) return false;
  run('git', ['commit', '-q', '-m', message], { cwd, mutate: true });
  run('git', ['push', '-u', 'origin', branch], { cwd, mutate: true });
  return true;
}

function createDraft(run, { repo, cwd, title, body, workdir, slug }) {
  const bodyFile = path.join(workdir, `${slug}.pr.md`);
  if (!run.dryRun)
    writeFileSync(bodyFile, `${body.trim()}\n\n${ATTRIBUTION}\n`);
  const result = run(
    'gh',
    [
      'pr',
      'create',
      '-R',
      repo,
      '--draft',
      '--reviewer',
      REVIEWER,
      '--title',
      title,
      '--body-file',
      bodyFile,
    ],
    { cwd, mutate: true },
  );
  return result.stdout.trim().split('\n').at(-1) || '(dry-run)';
}

function ensureWorktree(run, { primary, worktree, branch, base }) {
  run('git', ['fetch', 'origin', base], { cwd: primary });
  if (existsSync(worktree)) {
    const head = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktree,
    }).stdout.trim();
    if (head !== branch)
      throw new RunError(`${worktree} exists but is on ${head}, not ${branch}`);
    return 'reused';
  }
  const known = run('git', ['branch', '--list', branch], {
    cwd: primary,
  }).stdout.trim();
  run(
    'git',
    known
      ? ['worktree', 'add', worktree, branch]
      : ['worktree', 'add', worktree, '-b', branch, `origin/${base}`],
    { cwd: primary, mutate: true },
  );
  return 'created';
}

function scaffoldArgs(spec, extra = []) {
  const args = ['--repo', spec.repo.full];
  if (spec.runnerLabel) args.push('--runner-label', spec.runnerLabel);
  for (const file of spec.ciWorkflows) args.push('--ci-workflow', file);
  for (const name of spec.ciWorkflowNames)
    args.push('--ci-workflow-name', name);
  if (spec.ciChecks) args.push('--ci-checks', spec.ciChecks);
  if (spec.hooks) args.push('--hooks', spec.hooks);
  if (spec.repoToolsRev) args.push('--repo-tools-rev', spec.repoToolsRev);
  return [...args, ...extra];
}

export function stepTarget(ctx) {
  const { run, spec, workdir, toolsDir, log } = ctx;
  const repo = spec.repo;
  const branch = 'fleet/onboard';
  const existing = openPullRequest(run, repo.full, branch);
  if (existing)
    return { status: 'done', detail: existing.url, url: existing.url };
  const clone = path.join(workdir, repo.name);
  if (!existsSync(clone))
    run('gh', ['repo', 'clone', repo.full, clone, '--', '--quiet'], {
      mutate: true,
    });
  if (!existsSync(clone))
    return { status: 'planned', detail: `clone ${repo.full} into ${clone}` };
  const base = defaultBranch(run, repo.full);
  run('git', ['fetch', '-q', 'origin', base], { cwd: clone });
  run('git', ['checkout', '-q', '-B', branch, `origin/${base}`], {
    cwd: clone,
    mutate: true,
  });
  const read = (file) => {
    const full = path.join(clone, file);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  };
  const packageBefore = read('package.json');
  const scaffold = run(
    'node',
    [
      path.join(toolsDir, 'fleet-onboard.mjs'),
      'scaffold',
      ...scaffoldArgs(spec, ['--default-branch', base]),
      '--target',
      clone,
      ...(run.dryRun ? ['--check'] : []),
    ],
    { cwd: clone, allowFailure: true },
  );
  for (const line of scaffold.stdout.split('\n'))
    if (/^(conflict|note)\t/.test(line)) log(`target\t${line}`);
  if (scaffold.status === 2 || scaffold.status === 64)
    throw new RunError(`scaffold failed: ${scaffold.stderr.trim()}`);
  if (scaffold.status === 1 && !run.dryRun)
    return {
      status: 'blocked',
      detail:
        'scaffold reported conflicts with locally owned files; resolve them (or pass --force through a manual scaffold run) and re-run',
    };
  if (run.dryRun)
    return {
      status: scaffold.status === 0 ? 'unchanged' : 'planned',
      detail:
        scaffold.status === 0
          ? 'target already carries the scaffold'
          : `scaffold would write files and open a draft PR on ${branch}`,
    };
  // A Husky scaffold can add repo-tools to package.json. Install before
  // staging so its lockfile and the command invoked by the hooks both exist.
  if (read('package.json') !== packageBefore) {
    const [command, ...args] = dependencyInstallArgs(read);
    run(command, args, { cwd: clone, mutate: true });
    const unignored = run(
      'git',
      [
        'ls-files',
        '--others',
        '--exclude-standard',
        '--directory',
        '--',
        ':(glob)**/node_modules/**',
      ],
      { cwd: clone },
    ).stdout.trim();
    if (unignored)
      throw new RunError(
        'Dependency installation left unignored node_modules files; add dependency directories to .gitignore before committing the target scaffold.',
      );
  }
  const changed = commitAndPush(run, clone, {
    branch,
    message: 'chore: join the Agent LCARS fleet',
    all: true,
  });
  if (!changed)
    return {
      status: 'unchanged',
      detail: 'target already carries the scaffold',
    };
  const plan = run(
    'node',
    [
      path.join(toolsDir, 'fleet-onboard.mjs'),
      'plan',
      ...scaffoldArgs(spec, ['--default-branch', base]),
    ],
    { allowFailure: true },
  ).stdout;
  const url = createDraft(run, {
    repo: repo.full,
    cwd: clone,
    title: 'chore: join the Agent LCARS fleet',
    body: `Generated by jlapenna/agent-lcars tools/fleet-onboard-run.mjs.\n\nMerge this before the Agent LCARS admission PR; the control plane must only watch a repository whose main already carries this contract.\n\n${plan}`,
    workdir,
    slug: `${repo.name}-target`,
  });
  return { status: 'done', detail: url, url };
}

export function stepLcars(ctx) {
  const result = stepLcarsInner(ctx);
  const worktree = path.join(
    ctx.workdir,
    `agent-lcars-admit-${ctx.spec.repo.name}`,
  );
  return existsSync(worktree) ? { ...result, worktree } : result;
}

function stepLcarsInner(ctx) {
  const { run, spec, workdir, root } = ctx;
  const branch = `fleet/admit-${spec.repo.name}`;
  const existing = openPullRequest(run, LCARS_REPO, branch);
  if (existing)
    return { status: 'done', detail: existing.url, url: existing.url };
  const worktree = path.join(workdir, `agent-lcars-admit-${spec.repo.name}`);
  const state = ensureWorktree(run, {
    primary: root,
    worktree,
    branch,
    base: 'main',
  });
  if (!existsSync(worktree))
    return {
      status: 'planned',
      detail: `worktree ${worktree} on ${branch}, admit, draft PR`,
    };
  if (state === 'created')
    run('./tools/setup-worktree.sh', [], { cwd: worktree, mutate: true });
  const admit = run(
    'node',
    [
      path.join(worktree, 'tools', 'fleet-onboard.mjs'),
      'admit',
      '--repo',
      spec.repo.full,
      ...(spec.alias ? ['--alias', spec.alias] : []),
      ...(run.dryRun ? ['--check'] : []),
    ],
    { cwd: worktree, allowFailure: true },
  );
  if (admit.status === 2)
    throw new RunError(`admit failed: ${admit.stderr.trim()}`);
  if (run.dryRun)
    return {
      status: admit.status === 0 ? 'unchanged' : 'planned',
      detail:
        admit.status === 0
          ? 'already admitted on main'
          : `admit would edit the membership projections and open a draft PR on ${branch}`,
    };
  const changed = commitAndPush(run, worktree, {
    branch,
    message: `feat(fleet): admit ${spec.repo.full} to the control plane`,
    paths: [
      'config/github-labels.json',
      'apps/console/apphosting.yaml',
      '.github/workflows/label-contract-audit.yml',
    ],
  });
  if (!changed)
    return { status: 'unchanged', detail: 'already admitted on main' };
  const url = createDraft(run, {
    repo: LCARS_REPO,
    cwd: worktree,
    title: `feat(fleet): admit ${spec.repo.full} to the control plane`,
    body: `Generated by tools/fleet-onboard-run.mjs: \`fleet-onboard.mjs admit --repo ${spec.repo.full}\`.\n\nAdds the repository to the label manifest, both console repository lists, and the label-contract audit matrix. Merge only after the target repository's onboarding PR has landed on its main (docs/onboarding-repo.md, "Order matters").`,
    workdir,
    slug: `${spec.repo.name}-lcars`,
  });
  return { status: 'done', detail: url, url };
}

export function stepHomelab(ctx) {
  const { run, spec, workdir, homelab } = ctx;
  if (!homelab || !existsSync(path.join(homelab, '.git')))
    return {
      status: 'blocked',
      detail: `no Homelab checkout at ${homelab ?? '(unset)'}; pass --homelab DIR`,
    };
  const branch = `fleet/admit-${spec.repo.name}`;
  const existing = openPullRequest(run, HOMELAB_REPO, branch);
  if (existing)
    return { status: 'done', detail: existing.url, url: existing.url };
  run('git', ['fetch', '-q', 'origin', 'main'], { cwd: homelab });
  const helper = run(
    'git',
    ['cat-file', '-e', 'origin/main:bin/fleet-admit-repo.sh'],
    { cwd: homelab, allowFailure: true },
  );
  if (helper.status !== 0)
    return {
      status: 'blocked',
      detail:
        'bin/fleet-admit-repo.sh is not on jlapenna/homelab main yet; land that change first',
    };
  const worktree = path.join(workdir, `homelab-admit-${spec.repo.name}`);
  ensureWorktree(run, { primary: homelab, worktree, branch, base: 'main' });
  if (!existsSync(worktree))
    return {
      status: 'planned',
      detail: `worktree ${worktree} on ${branch}, fleet-admit-repo.sh, draft PR`,
    };
  const laneArgs = spec.runnerLabel ? ['--lane', spec.runnerLabel] : [];
  const admit = run(
    'bin/fleet-admit-repo.sh',
    [spec.repo.full, ...laneArgs, ...(run.dryRun ? ['--check'] : [])],
    { cwd: worktree, allowFailure: true },
  );
  if (run.dryRun)
    return {
      status: admit.status === 0 ? 'unchanged' : 'planned',
      detail:
        admit.status === 0
          ? 'already present in Homelab membership'
          : `fleet-admit-repo.sh would edit membership and open a draft PR on ${branch}`,
    };
  if (admit.status !== 0)
    throw new RunError(`fleet-admit-repo.sh exited ${admit.status}`);
  run('bin/fleet-admit-repo.sh', [spec.repo.full, '--check'], {
    cwd: worktree,
  });
  const changed = commitAndPush(run, worktree, {
    branch,
    message: `feat(fleet): admit ${spec.repo.full}`,
    paths: ['fleet/repositories.tsv', 'observability/docker-compose.yml'],
  });
  if (!changed)
    return {
      status: 'unchanged',
      detail: 'already present in Homelab membership',
    };
  const url = createDraft(run, {
    repo: HOMELAB_REPO,
    cwd: worktree,
    title: `feat(fleet): admit ${spec.repo.full}`,
    body: `Generated by jlapenna/agent-lcars tools/fleet-onboard-run.mjs: \`bin/fleet-admit-repo.sh ${spec.repo.full}${laneArgs.length ? ` ${laneArgs.join(' ')}` : ''}\`.\n\nAdds the repository to the ruleset executor's membership table and the Actions exporter list. The reviewed Terraform plan/apply for the repository-owned ruleset root remains a separate operator step.${
      laneArgs.length
        ? `\n\nLane edits printed by the helper (capacity decision, not applied):\n\n\`\`\`\n${admit.stdout.trim()}\n\`\`\``
        : ''
    }`,
    workdir,
    slug: `${spec.repo.name}-homelab`,
  });
  return { status: 'done', detail: url, url };
}

function manifestLists(file, repo) {
  try {
    return Boolean(JSON.parse(readFileSync(file, 'utf8')).repositories?.[repo]);
  } catch {
    return false;
  }
}

export function stepGithub(ctx) {
  const {
    run,
    spec,
    toolsDir,
    log,
    copyFrom,
    privateKeyCommand,
    lcarsWorktree,
  } = ctx;
  // The helper syncs labels from the manifest beside its own module. Until
  // the admission PR merges, only the admission worktree's manifest lists
  // the repository, so run the helper from there; with neither, defer the
  // label sync to a human instead of reporting a guaranteed failure.
  const helperDir = lcarsWorktree
    ? path.join(lcarsWorktree, 'tools')
    : toolsDir;
  const admitted = manifestLists(
    path.join(helperDir, '..', 'config', 'github-labels.json'),
    spec.repo.full,
  );
  const args = [
    path.join(helperDir, 'fleet-onboard-github.mjs'),
    '--repo',
    spec.repo.full,
    '--copy-from',
    copyFrom,
  ];
  if (!admitted) args.push('--skip-labels');
  if (privateKeyCommand) args.push('--private-key-command', privateKeyCommand);
  if (run.dryRun) args.push('--dry-run');
  const result = run('node', args, { allowFailure: true });
  const facts = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    log(`github\t${line}`);
    try {
      facts.push(JSON.parse(line));
    } catch {
      // Non-JSON lines are progress text; keep going.
    }
  }
  const human = facts.filter(
    (fact) =>
      String(fact.fact).startsWith('installation:') &&
      fact.status !== 'PASS' &&
      fact.status !== 'PLAN',
  );
  if (result.status === 2)
    throw new RunError(`fleet-onboard-github failed: ${result.stderr.trim()}`);
  const humanItems = human.map(
    (fact) => `${fact.fact}: ${fact.detail ?? fact.status}`,
  );
  if (!admitted)
    humanItems.push(
      `labels: after the admission PR merges, run node tools/sync-github-labels.mjs --apply --repo=${spec.repo.full} from a current checkout`,
    );
  return {
    status: result.status === 0 ? 'done' : 'attention',
    detail: `${facts.length} facts, ${humanItems.length} needing a maintainer`,
    human: humanItems,
  };
}

const STEP_FUNCTIONS = {
  target: stepTarget,
  lcars: stepLcars,
  homelab: stepHomelab,
  github: stepGithub,
};

export function renderSummary(spec, results) {
  const lines = [`# Onboarding ${spec.repo.full}`, ''];
  for (const step of STEPS) {
    const result = results[step];
    if (!result) continue;
    lines.push(
      `- ${step}: ${result.status}${result.detail ? ` — ${result.detail}` : ''}`,
    );
  }
  lines.push('', '## Remaining human steps', '');
  const human = results.github?.human ?? [];
  if (human.length) for (const item of human) lines.push(`- ${item}`);
  else
    lines.push(
      '- Confirm both GitHub App installations include the repository (GitHub UI; see docs/fleet-credentials.md).',
    );
  lines.push(
    '- Merge order: target PR, then Homelab PR, then the Agent LCARS admission PR.',
    '- Homelab executor: reviewed Terraform plan/apply for infra/github-ruleset (homelab terraform/README.md).',
    `- Then: node tools/verify-onboarding.mjs --repo=${spec.repo.full}`,
  );
  return lines.join('\n');
}

export function resolveRunSpec(options) {
  const repo = parseRepo(options.repo);
  const split = (value) =>
    (value ?? [])
      .flatMap((item) => item.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
  const skip = new Set(split(options.skip));
  for (const step of skip)
    if (!STEPS.includes(step))
      throw new RunError(`--skip ${step}: unknown step`);
  return {
    repo,
    alias: options.alias || null,
    runnerLabel: options['runner-label'] || null,
    ciWorkflows: split(options['ci-workflow']),
    ciWorkflowNames: split(options['ci-workflow-name']),
    ciChecks: options['ci-checks'] || null,
    hooks: options.hooks || null,
    repoToolsRev: options['repo-tools-rev'] || null,
    copyFrom: parseRepo(
      options['copy-from'] ?? 'jlapenna/sync-padd',
      '--copy-from',
    ).full,
    skip,
  };
}

export function runAll({
  spec,
  run,
  workdir,
  root,
  toolsDir,
  homelab,
  log,
  privateKeyCommand,
}) {
  const results = {};
  for (const step of STEPS) {
    if (spec.skip.has(step)) {
      results[step] = { status: 'skipped', detail: '--skip' };
      log(`${step}\tskipped\t--skip`);
      continue;
    }
    try {
      results[step] = STEP_FUNCTIONS[step]({
        run,
        spec,
        workdir,
        root,
        toolsDir,
        homelab,
        log,
        copyFrom: spec.copyFrom,
        privateKeyCommand,
        lcarsWorktree: results.lcars?.worktree,
      });
    } catch (error) {
      if (!(error instanceof RunError)) throw error;
      results[step] = { status: 'failed', detail: error.message };
    }
    log(`${step}\t${results[step].status}\t${results[step].detail ?? ''}`);
  }
  return results;
}

const USAGE = `usage:
  fleet-onboard-run.mjs --repo OWNER/NAME [--runner-label L]
      [--ci-workflow FILE]... [--ci-workflow-name NAME]... [--ci-checks "A,B"]
      [--hooks auto|pre-commit|husky|none] [--repo-tools-rev TAG] [--alias NAME]
      [--copy-from OWNER/NAME] [--private-key-command CMD]
      [--homelab DIR] [--workdir DIR] [--dry-run] [--skip STEP]...

Steps: ${STEPS.join(', ')}. Each is idempotent: an open pull request on the
step's branch counts as done. --dry-run performs no clone, commit, push, PR,
or API write and reports what would happen. Exit codes: 0 every step done,
unchanged, or skipped; 1 a step is blocked, failed, or needs attention; 2
usage or input error.`;

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      alias: { type: 'string' },
      'runner-label': { type: 'string' },
      'ci-workflow': { type: 'string', multiple: true },
      'ci-workflow-name': { type: 'string', multiple: true },
      'ci-checks': { type: 'string' },
      hooks: { type: 'string' },
      'repo-tools-rev': { type: 'string' },
      'copy-from': { type: 'string' },
      'private-key-command': { type: 'string' },
      homelab: { type: 'string' },
      workdir: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      skip: { type: 'string', multiple: true },
      help: { type: 'boolean', default: false },
    },
  });
  return values;
}

export function main(
  argv,
  { root, exec = createExec(), log = console.log } = {},
) {
  const options = parseCli(argv);
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const spec = resolveRunSpec(options);
  const toolsDir = path.join(root, 'tools');
  const workdir = path.resolve(
    options.workdir ?? path.join(tmpdir(), `fleet-onboard-${spec.repo.name}`),
  );
  if (!options['dry-run']) mkdirSync(workdir, { recursive: true });
  const homelab = path.resolve(
    options.homelab ?? path.join(root, '..', 'homelab'),
  );
  const run = createRunner({ exec, dryRun: options['dry-run'], log });
  const results = runAll({
    spec,
    run,
    workdir,
    root,
    toolsDir,
    homelab,
    log,
    privateKeyCommand: options['private-key-command'],
  });
  log(`\n${renderSummary(spec, results)}`);
  const bad = Object.values(results).some((result) =>
    ['blocked', 'failed', 'attention'].includes(result.status),
  );
  return bad ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] &&
  (() => {
    try {
      return (
        realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
      );
    } catch {
      return false;
    }
  })();

if (invokedDirectly) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    process.exitCode = main(process.argv.slice(2), { root });
  } catch (error) {
    if (error instanceof RunError) {
      console.error(`fleet-onboard-run: ${error.message}`);
      process.exitCode = 2;
    } else throw error;
  }
}
