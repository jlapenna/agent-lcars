// One native session must edit, commit, push and publish before the actual
// runner verifier accepts completion. Git is real; GitHub is a local transport.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeNativeFailure } from './runner-failure-fixture.mjs';
import { workflowRecoveryFixture } from './workflow-recovery-fixture.mjs';
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

export function workflowFixture(directory, home, mode) {
  const recoveryExhausted = mode === 'bootstrap-workflow-recovery-exhausted';
  const exhausted = mode === 'bootstrap-workflow-exhausted';
  const correction = mode === 'bootstrap-workflow-correction' || exhausted;
  let correcting = false;
  let correctionEvidence;
  let finalizationEvidence;
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
  const recovery =
    mode === 'bootstrap-workflow-recovery' || recoveryExhausted
      ? workflowRecoveryFixture(
          directory,
          target,
          preserved,
          content,
          recoveryExhausted,
        )
      : undefined;
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
    installRecovery: (provider, configPath) =>
      recovery?.install(provider, configPath),
    expectPublication: !exhausted && !recoveryExhausted,
    expectedOwnershipReads: recoveryExhausted ? 1 : exhausted ? 4 : 5,
    denial: recoveryExhausted ? 'infrastructure failure' : '',
    budgetMs: exhausted ? 30000 : 60000,
    next(input) {
      if (pending && resultIds(input).has(pending.id)) {
        completed.push(pending);
        pending = undefined;
        cursor++;
      }
      return pending ||
        (recoveryExhausted && cursor === 2) ||
        (correction && cursor === 4 && !correcting)
        ? null
        : steps[cursor];
    },
    issued(id) {
      if (pending || !steps[cursor])
        throw new Error('Invalid workflow tool sequence');
      pending = { name: steps[cursor].name, id };
    },
    async correct(context, runtimeEnv, execution, deadline, resume) {
      if (recoveryExhausted) {
        finalizationEvidence = await finalizeNativeFailure(
          directory,
          context,
          runtimeEnv,
          deadline,
        );
        return;
      }
      if (!correction) return;
      const before = this.completion(context, runtimeEnv, 'premature');
      // Let the original wall-clock budget actually expire. Do not substitute
      // a fabricated timestamp or give a resumed process a fresh deadline.
      if (exhausted)
        await new Promise((done) =>
          setTimeout(done, Math.max(1, deadline - Date.now() + 25)),
        );
      let heartbeats = 0;
      const lease = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/heartbeat') {
          heartbeats++;
          res.writeHead(200);
        } else res.writeHead(404);
        res.end();
      });
      await new Promise((done) => lease.listen(0, '127.0.0.1', done));
      const remaining = Math.floor((deadline - Date.now()) / 1000);
      const helperRoot = fileURLToPath(
        new URL(
          '../../apps/runner-autoscaler/runner-image/runtime/',
          import.meta.url,
        ),
      );
      let decision;
      try {
        decision = await new Promise((done) => {
          const child = spawn(
            'bash',
            [
              '-c',
              'source "$1/worker-policy-bootstrap.sh"; source "$1/worker-completion.sh"; worker_completion_needed "$2" "$((SECONDS + $3))" && worker_authorize_correction && printf "%s" "$WORKER_COMPLETION_PROMPT"',
              'workflow-correction',
              helperRoot,
              String(execution.code ?? 1),
              String(remaining),
            ],
            {
              cwd: workspace,
              env: {
                ...runtimeEnv,
                RUNNER_TEMP: directory,
                AGENT_NAME: context.provider,
                TARGET_REPO: context.repository,
                ISSUE: '42',
                MODE: context.mode,
                ANCHOR_TYPE: 'issue',
                ATTEMPT_ID: context.attemptId,
                VERIFY_OUTCOME: join(helperRoot, 'verify-outcome.sh'),
                RUNS_API: `http://127.0.0.1:${lease.address().port}`,
                AUTH_HEADER: 'Authorization: Bearer local-fixture-only',
                CURL_TIMEOUT_CONFIG: 'connect-timeout = 2\nmax-time = 5',
              },
              // The short local decision read is allowed after expiration; no
              // native work is launched unless the real helper authorizes it.
              timeout: exhausted ? 5000 : Math.max(1, deadline - Date.now()),
            },
          );
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (data) => {
            stdout += data;
          });
          child.stderr.on('data', (data) => {
            stderr += data;
          });
          child.on('error', (error) =>
            done({ code: null, error: error.message }),
          );
          child.on('close', (code) => done({ code, stdout, stderr }));
        });
      } finally {
        lease.closeAllConnections();
        await new Promise((done) => lease.close(done));
      }
      let resumed;
      if (decision.code === 0 && decision.stdout && Date.now() < deadline) {
        correcting = true;
        resumed = await resume(
          decision.stdout,
          Math.max(1, deadline - Date.now()),
        );
      }
      correctionEvidence = {
        before,
        decision,
        heartbeats,
        resumed: !!resumed,
        resumedCode: resumed?.code,
        originalDeadlineRetained: exhausted
          ? !resumed && Date.now() >= deadline
          : !!resumed && !resumed.timedOut && Date.now() < deadline,
      };
      writeFileSync(
        join(directory, 'correction.json'),
        JSON.stringify(correctionEvidence, null, 2),
      );
      return correctionEvidence;
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
    verify(context, sessionId, deadline) {
      const recoveryEvidence = recovery?.verify(
        join(directory, 'worker-policy-context.json'),
        context.attemptId,
        sessionId,
        deadline,
      );
      let details;
      try {
        const head = git(['rev-parse', 'HEAD']);
        const published = existsSync(sentinel)
          ? JSON.parse(readFileSync(sentinel, 'utf8'))
          : null;
        const events = readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
        details = {
          steps: completed.map(({ name }) => name),
          sameNativeSession:
            !!sessionId &&
            events.length >=
              (recoveryExhausted ? 2 : exhausted ? 4 : steps.length) &&
            events.every((e) => (e.session_id ?? e.sessionID) === sessionId),
          ...(recoveryExhausted
            ? {
                implementationRetained:
                  readFileSync(target, 'utf8') === content,
                stagingBlocked: git(['diff', '--cached', '--name-only']) === '',
                commitAbsent: head === originalHead,
                pushAbsent:
                  git([
                    '--git-dir',
                    remote,
                    'for-each-ref',
                    '--format=%(refname)',
                  ]) === '',
              }
            : {
                implementationCommitted:
                  head !== originalHead &&
                  git(['show', 'HEAD:implementation.txt']) ===
                    content.trimEnd(),
                exactRemoteCommit:
                  git([
                    '--git-dir',
                    remote,
                    'rev-parse',
                    'refs/heads/workflow',
                  ]) === head,
                exactRemoteTree:
                  git([
                    '--git-dir',
                    remote,
                    'ls-tree',
                    '-r',
                    '--name-only',
                    'refs/heads/workflow',
                  ]) === 'implementation.txt',
              }),
          preservedWork:
            readFileSync(preserved, 'utf8') ===
            'retain unrelated unpublished work\n',
          ...(exhausted || recoveryExhausted
            ? { publicationAbsent: published === null }
            : {
                exactMarkerOnce:
                  published[published.indexOf('--body') + 1] ===
                  `Fixture deliverable\n\n<!-- attempt-claim:${context.attemptId} -->`,
              }),
        };
      } catch (error) {
        details = { error: error.message };
      }
      const correctionPassed =
        !correction ||
        (correctionEvidence?.before.code === 1 &&
          correctionEvidence.before.missing &&
          correctionEvidence.decision.code === (exhausted ? 1 : 0) &&
          correctionEvidence.heartbeats === (exhausted ? 0 : 1) &&
          correctionEvidence.resumed === !exhausted &&
          (exhausted || correctionEvidence.resumedCode === 0) &&
          correctionEvidence.originalDeadlineRetained);
      const passed =
        (!recoveryExhausted || finalizationEvidence?.passed === true) &&
        (!recovery ||
          Object.values(recoveryEvidence).every((value) => value === true)) &&
        correctionPassed &&
        !pending &&
        cursor === (recoveryExhausted ? 2 : exhausted ? 4 : steps.length) &&
        Object.entries(details).every(([key, value]) =>
          key === 'steps'
            ? value.length ===
              (recoveryExhausted ? 2 : exhausted ? 4 : steps.length)
            : value === true,
        );
      return {
        passed,
        ...details,
        ...(recovery ? { recovery: recoveryEvidence } : {}),
        ...(recoveryExhausted ? { finalization: finalizationEvidence } : {}),
        ...(correction ? { correction: correctionEvidence } : {}),
      };
    },
  };
}
