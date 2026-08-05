import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const workflowsDirectory = path.resolve('.github/workflows');
const brokerPrefix = 'agent-lcars-dispatch-v1-';
const expectedGroup = '${{ needs.normalize.outputs.group }}';

async function workflowSources() {
  const names = (await fs.readdir(workflowsDirectory)).filter((name) =>
    /\.ya?ml$/u.test(name),
  );
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await fs.readFile(path.join(workflowsDirectory, name), 'utf8'),
    })),
  );
}

function concurrencyGroups(source) {
  return source.split(/\r?\n/gu).flatMap((line) => {
    const match = /^\s*group:\s*['"]?(.+?)['"]?\s*$/u.exec(line);
    return match ? [match[1]] : [];
  });
}

test('no other workflow declares the broker reserved namespace', async () => {
  const occurrences = [];
  for (const workflow of await workflowSources()) {
    for (const group of concurrencyGroups(workflow.source)) {
      if (group.toLowerCase().includes(brokerPrefix)) {
        occurrences.push({ name: workflow.name, group });
      }
    }
  }
  assert.deepEqual(occurrences, []);
});

test('queue max is paired with noncancelling serialized execution only', async () => {
  for (const workflow of await workflowSources()) {
    const queues = [
      ...workflow.source.matchAll(/^\s*queue:\s*(\S+)\s*$/gmu),
    ].map((match) => match[1]);
    assert.equal(
      queues.every((queue) => ['single', 'max'].includes(queue)),
      true,
      `${workflow.name} declares an unsupported queue policy`,
    );
    if (['agent-router.yml', 'codex.yml'].includes(workflow.name)) {
      assert.deepEqual(queues, ['max']);
      assert.match(workflow.source, /^\s*cancel-in-progress:\s*false\s*$/mu);
    } else {
      assert.equal(
        queues.length,
        0,
        `${workflow.name} unexpectedly declares a queue policy`,
      );
    }
  }
});

test('workers carry no per-issue concurrency group; the broker owns that dedup (#321)', async () => {
  const sources = await workflowSources();
  for (const worker of [
    'claude.yml',
    'opencode.yml',
    'agent-dispatch-canary.yml',
  ]) {
    const source = sources.find(
      (candidate) => candidate.name === worker,
    )?.source;
    assert.ok(source, `${worker} is missing`);
    for (const group of concurrencyGroups(source)) {
      assert.doesNotMatch(
        group,
        /-issue-/u,
        `${worker} must not declare a per-issue concurrency group; GitHub ` +
          'keeps only one pending run per group, which silently kills a ' +
          'second queued run before its failure-report step can fire. ' +
          'dispatch-broker/broker.mjs (beginDispatch/acceptIntent) now ' +
          'owns dispatch dedup and serialization for one issue.',
      );
    }
  }
  const codexSource = sources.find(
    (candidate) => candidate.name === 'codex.yml',
  )?.source;
  assert.ok(codexSource, 'codex.yml is missing');
  assert.deepEqual(
    concurrencyGroups(codexSource),
    ['codex-subscription-auth'],
    'codex.yml must keep its repository-wide credential-serialization ' +
      'group even though the per-issue groups are gone: it guards a ' +
      'shared subscription auth.json refresh, which the broker does not ' +
      'cover',
  );
});

test('codex.yml has no disabled legacy queue hand-off step (#307)', async () => {
  // The v1 broker's dispatchAccepted() (main.mjs) now owns promoting and
  // re-dispatching a queued generation once the active one completes -- see
  // broker.mjs's completeRun/markDispatchRejected. The old in-workflow
  // "dispatch the next unclaimed codex issue" step this repo carried as a
  // permanently `if: false` compatibility placeholder is gone; guard against
  // it quietly coming back.
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'codex.yml'),
    'utf8',
  );
  assert.doesNotMatch(source, /Dispatch the next queued Codex issue/u);
  assert.doesNotMatch(source, /if:\s*\$\{\{\s*false\s*\}\}/u);
});

test('workers are dispatch-only and cannot subscribe directly to issue events', async () => {
  const sources = await workflowSources();
  for (const worker of [
    'claude.yml',
    'codex.yml',
    'opencode.yml',
    'agent-dispatch-canary.yml',
  ]) {
    const source = sources.find(
      (candidate) => candidate.name === worker,
    )?.source;
    assert.ok(source, `${worker} is missing`);
    assert.doesNotMatch(source, /^\s+(issues|issue_comment):\s*$/mu);
  }
});

test('router serializes issue and pull-request lifecycle through one normalized group output', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  assert.ok(source.includes(`group: ${expectedGroup}`));
  assert.match(
    source,
    /^\s+group:\s+\$\{\{ steps\.normalize\.outputs\.group \}\}\s*$/mu,
  );
  assert.match(source, /^\s+pull_request:\s*$/mu);
  assert.match(
    source,
    /^\s+types:\s+\[closed, reopened, labeled, unlabeled\]\s*$/mu,
  );
  assert.match(source, /^\s+pull-requests:\s+write\s*$/mu);
});

test('the canary worker (#307) is structurally incapable of running a paid or privileged agent', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-dispatch-canary.yml'),
    'utf8',
  );
  // Only a GitHub-hosted runner, never the self-hosted/paid agent pool
  // claude.yml/codex.yml/opencode.yml use.
  assert.match(source, /^\s+runs-on:\s+ubuntu-latest\s*$/mu);
  assert.doesNotMatch(source, /\$\{\{\s*vars\.AGENT_RUNNER_LABEL\s*\}\}/u);
  // No secret of any kind -- no model credential, no GCP workload identity,
  // no App token mint. The only credential in scope is GitHub's own
  // ambient per-job token.
  assert.doesNotMatch(source, /secrets\./u);
  // Every worker calls the broker's completion-callback unconditionally so
  // a crashed run still clears its ledger generation (#305's reconciler is
  // only ever a backstop, never the primary path).
  assert.match(source, /operation:\s*completion-callback/u);
  const completionStepIndex = source.indexOf('operation: completion-callback');
  const precedingSource = source.slice(0, completionStepIndex);
  const lastAlwaysIndex = precedingSource.lastIndexOf('if: always()');
  assert.ok(
    lastAlwaysIndex >= 0 &&
      precedingSource
        .slice(lastAlwaysIndex)
        .includes('uses: ./.github/actions/dispatch-broker'),
    'the completion-callback step must run under if: always()',
  );
});

test('the canary orchestrators (#307) never reference a self-hosted runner or a secret', async () => {
  for (const workflow of ['dispatch-canary.yml', 'post-deploy-smoke.yml']) {
    const source = await fs.readFile(
      path.join(workflowsDirectory, workflow),
      'utf8',
    );
    assert.doesNotMatch(source, /\$\{\{\s*vars\.AGENT_RUNNER_LABEL\s*\}\}/u);
    assert.doesNotMatch(source, /secrets\./u);
    assert.match(source, /^\s+runs-on:\s+ubuntu-latest\s*$/mu);
  }
});

test('post-deploy-smoke.yml gates only on conclusion, never on head_branch (#307 P2 fix)', async () => {
  // deploy-console.yml's gate job fails unless the triggering CI run's
  // Verify job passed, and deploy depends on that gate. Its workflow-level
  // conclusion can therefore be 'success' only when deploy actually ran and
  // succeeded. A `head_branch == 'main'` filter here would silently skip
  // verifying a real production deploy triggered by workflow_dispatch from a
  // non-main ref.
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'post-deploy-smoke.yml'),
    'utf8',
  );
  assert.match(
    source,
    /^\s+if:\s+github\.event\.workflow_run\.conclusion == 'success'\s*$/mu,
  );
  // Scoped to the actual job config (after `jobs:`), not this file's own
  // explanatory header comment, which legitimately discusses head_branch
  // as the filter this fix removed.
  const jobsSection = source.slice(source.indexOf('\njobs:'));
  assert.doesNotMatch(jobsSection, /head_branch/u);
});

test('deploy-console.yml fails closed when the triggering Verify job did not pass (#543)', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'deploy-console.yml'),
    'utf8',
  );
  assert.match(
    source,
    /else\s+echo "verify_passed=false"[^]*?echo "::error::Verify did not pass[^]*?exit 1\s+fi/u,
  );
  assert.match(source, /^\s+needs:\s+gate\s*$/mu);
  assert.match(
    source,
    /^\s+if:\s+needs\.gate\.outputs\.verify_passed == 'true'\s*$/mu,
  );
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}
if (failures > 0) process.exitCode = 1;
