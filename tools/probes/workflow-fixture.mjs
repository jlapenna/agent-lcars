// One native session must edit, commit, push and publish before the actual
// runner verifier accepts completion. Git is real; GitHub is a local transport.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { fileProbeFixture } from './worktree-fixture.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function resultIds(value, into = new Set()) {
  if (!value || typeof value !== 'object') return into;
  if (['function_call_output', 'custom_tool_call_output'].includes(value.type))
    into.add(value.call_id);
  if (value.type === 'tool_result') into.add(value.tool_use_id);
  if (value.role === 'tool') into.add(value.tool_call_id);
  for (const child of Object.values(value)) resultIds(child, into);
  return into;
}

export function workflowFixture(directory, home) {
  fileProbeFixture(directory, home, 'bootstrap-workflow');
  const workspace = join(directory, 'workspace');
  const target = join(workspace, 'implementation.txt');
  const content = 'LCARS_NATIVE_WORKFLOW_IMPLEMENTATION\n';
  const sentinel = join(directory, 'published-pr.json');
  const eventsPath = join(directory, 'workflow-events.jsonl');
  const remote = join(directory, 'remote.git');
  const preserved = join(workspace, 'unpublished-work.txt');
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Native workflow probe',
    GIT_AUTHOR_EMAIL: 'probe@example.test',
    GIT_COMMITTER_NAME: 'Native workflow probe',
    GIT_COMMITTER_EMAIL: 'probe@example.test',
  };
  const git = (args) =>
    execFileSync('git', args, {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: home, ...env },
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  git(['init', '--bare', remote]);
  const originalHead = git(['rev-parse', 'HEAD']);
  writeFileSync(preserved, 'retain unrelated unpublished work\n');
  const steps = [
    { name: 'edit', kind: 'write' },
    {
      name: 'stage',
      command: `git -C ${quote(workspace)} add -- implementation.txt`,
    },
    {
      name: 'commit',
      command: `git -C ${quote(workspace)} commit -m 'Native workflow implementation'`,
    },
    {
      name: 'push',
      command: `git -C ${quote(workspace)} push ${quote(remote)} HEAD:refs/heads/workflow`,
    },
    {
      name: 'publish',
      command:
        'gh pr create --repo octo/example --title "Fixture PR" --body "Fixture deliverable"',
    },
  ];
  let cursor = 0;
  let pending;
  const completed = [];
  return {
    target,
    content,
    sentinel,
    eventsPath,
    env,
    next(input) {
      if (pending && resultIds(input).has(pending.id)) {
        completed.push(pending);
        pending = undefined;
        cursor++;
      }
      return pending ? null : steps[cursor];
    },
    issued(id) {
      if (pending || !steps[cursor])
        throw new Error('Invalid workflow tool sequence');
      pending = { name: steps[cursor].name, id };
    },
    // Honor the verifier's actual jq filter rather than returning a fabricated
    // success string. The artifact body comes only from native gh publication.
    apiSource: `
if (args[1] === 'repos/octo/example/pulls?state=all&per_page=100' || args[1] === 'repos/octo/example/issues/42/comments?per_page=100') {
  const published = fs.existsSync(${JSON.stringify(sentinel)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8')) : null;
  const records = published && args[1].includes('/pulls?') ? [{number:73,user:{type:'Bot'},title:'Fixture PR',body:published[published.indexOf('--body')+1]}] : [];
  const result = require('node:child_process').spawnSync('jq', ['-r', args[args.indexOf('--jq')+1]], {input:JSON.stringify(records),encoding:'utf8',timeout:5000});
  process.stdout.write(result.stdout || '');
  process.exit(result.status ?? 1);
}
`,
    completion(context, runtimeEnv, label) {
      const record = join(directory, `completion-${label}.env`);
      writeFileSync(record, '');
      const result = spawnSync(
        'bash',
        [
          resolve(
            'apps/runner-autoscaler/runner-image/runtime/verify-outcome.sh',
          ),
        ],
        {
          cwd: workspace,
          env: {
            ...runtimeEnv,
            AGENT: context.provider,
            REPO: context.repository,
            NUM: '42',
            MODE: context.mode,
            ATTEMPT_ID: context.attemptId,
            RUNTIME_ENV: record,
          },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      const observed = {
        code: result.status,
        missing: readFileSync(record, 'utf8').includes('NO_DELIVERABLE=1'),
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      };
      writeFileSync(
        join(directory, `completion-${label}.json`),
        JSON.stringify(observed, null, 2),
      );
      return observed;
    },
    verify(context, sessionId) {
      let details;
      try {
        const head = git(['rev-parse', 'HEAD']);
        const published = JSON.parse(readFileSync(sentinel, 'utf8'));
        const events = readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
        details = {
          steps: completed.map(({ name }) => name),
          sameNativeSession:
            !!sessionId &&
            events.length >= steps.length &&
            events.every((e) => (e.session_id ?? e.sessionID) === sessionId),
          implementationCommitted:
            head !== originalHead &&
            git(['show', 'HEAD:implementation.txt']) === content.trimEnd(),
          exactRemoteCommit:
            git(['--git-dir', remote, 'rev-parse', 'refs/heads/workflow']) ===
            head,
          exactRemoteTree:
            git([
              '--git-dir',
              remote,
              'ls-tree',
              '-r',
              '--name-only',
              'refs/heads/workflow',
            ]) === 'implementation.txt',
          preservedWork:
            readFileSync(preserved, 'utf8') ===
            'retain unrelated unpublished work\n',
          exactMarkerOnce:
            published[published.indexOf('--body') + 1] ===
            `Fixture deliverable\n\n<!-- attempt-claim:${context.attemptId} -->`,
        };
      } catch (error) {
        details = { error: error.message };
      }
      const passed =
        !pending &&
        cursor === steps.length &&
        Object.entries(details).every(([key, value]) =>
          key === 'steps' ? value.length === steps.length : value === true,
        );
      return { passed, ...details };
    },
  };
}
