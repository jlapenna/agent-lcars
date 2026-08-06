import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { agentWorkerPipelines, workerWorkflow } from './github-api.mjs';

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

const workerWorkflowNames = agentWorkerPipelines.map(workerWorkflow);

function dispatchInputNames(source) {
  const lines = source.split(/\r?\n/gu);
  const start = lines.findIndex((line) => /^ {4}inputs:\s*$/u.test(line));
  assert.notEqual(start, -1, 'workflow_dispatch inputs block is missing');
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    const match = /^ {6}([a-z0-9_]+):\s*$/u.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

function assertOrderedSteps(steps, workflow, stepNames) {
  let previous = -1;
  for (const stepName of stepNames) {
    const matches = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.name === stepName);
    assert.equal(
      matches.length,
      1,
      `${workflow} must have one ${stepName} step`,
    );
    const [{ index }] = matches;
    assert.ok(
      index > previous,
      `${workflow} must run ${stepName} after the preceding common step`,
    );
    previous = index;
  }
}

function laneValue(source, workflow, field) {
  const match = new RegExp(`^ {6}${field}:\\s+(.+)$`, 'mu').exec(source);
  assert.ok(match, `${workflow} must declare ${field} as lane data`);
  return match[1].replace(/^(['"])(.*)\1$/u, '$2');
}

function stepBlocks(source) {
  const starts = [...source.matchAll(/^ {6}- name: (.+)$/gmu)];
  return starts.map((match, index) => ({
    name: match[1],
    source: source.slice(
      match.index,
      starts[index + 1]?.index ?? source.length,
    ),
  }));
}

function namedStep(steps, workflow, name) {
  const matches = steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, `${workflow} must have one ${name} step`);
  return matches[0];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function stepField(field, value, indentation = 8) {
  return new RegExp(
    `^ {${indentation}}${escapeRegex(field)}:\\s+${escapeRegex(value)}` +
      '(?:\\s+#.*)?$',
    'mu',
  );
}

function actionStep(steps, workflow, action) {
  const matches = steps.filter((step) =>
    stepField('uses', action).test(step.source),
  );
  assert.equal(
    matches.length,
    1,
    `${workflow} must invoke ${action} in exactly one step`,
  );
  return matches[0];
}

function agentAdapterStep(steps, workflow) {
  const matches = steps.filter((step) =>
    stepField('id', 'agent').test(step.source),
  );
  assert.equal(
    matches.length,
    1,
    `${workflow} must expose exactly one adapter as steps.agent`,
  );
  return matches[0];
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

test('opencode uses the published action with a bounded trajectory contract', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'opencode.yml'),
    'utf8',
  );
  assert.match(
    source,
    /uses:\s+anomalyco\/opencode\/github@[0-9a-f]{40}\s+#/u,
    'opencode.yml must use a pinned published OpenCode action',
  );
  assert.match(source, /timeout-minutes:\s*30\s*$/mu);
  assert.match(source, /^\s+agent:\s+build\s*$/mu);
  assert.match(source, /^\s+variant:\s+minimal\s*$/mu);
  assert.match(source, /first durable\s+artifact/u);
  assert.match(source, /exactly one\s+of: PR <url>, PARK/u);
});

test('workers expose one canonical dispatch and lane-configuration contract', async () => {
  const sources = await workflowSources();
  const expectedInputs = [
    'issue',
    'mode',
    'reply',
    'runbook',
    'context',
    'broker_intent_id',
    'broker_generation',
    'broker_dispatch_token',
  ];
  for (const workflow of workerWorkflowNames) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    const agent = laneValue(source, workflow, 'AGENT_NAME');
    assert.deepEqual(dispatchInputNames(source), expectedInputs);
    assert.equal(
      /^run-name:\s+(.+)$/mu.exec(source)?.[1],
      "'#${{ inputs.issue }}: " +
        `${agent} issue agent ` +
        "[dispatch:g${{ inputs.broker_generation }}:${{ inputs.broker_intent_id }}]'",
      `${workflow} must derive its run name from canonical inputs and lane data`,
    );
    assert.doesNotMatch(source, /github\.event\.inputs/u);
    assert.doesNotMatch(source, /missing=""/u);
    assert.equal(
      laneValue(source, workflow, 'WORKER_WORKFLOW'),
      workflow,
      `${workflow} must identify itself to the broker`,
    );
    for (const field of [
      'AGENT_GIT_LOGIN',
      'EXPECTED_COMMENT_LOGIN',
      'EXCLUDE_PR_AUTHOR',
      'AGENT_LABEL',
      'REDISPATCH_COMMAND',
    ]) {
      assert.ok(
        laneValue(source, workflow, field),
        `${workflow} must declare nonempty ${field} lane data`,
      );
    }
    for (const use of [
      'agent-login: ${{ env.AGENT_GIT_LOGIN }}',
      'agent: ${{ env.AGENT_NAME }}',
      'EXPECTED_COMMENT_LOGIN: ${{ env.EXPECTED_COMMENT_LOGIN }}',
      'EXCLUDE_PR_AUTHOR: ${{ env.EXCLUDE_PR_AUTHOR }}',
      '$AGENT_LABEL',
      '$REDISPATCH_COMMAND',
    ]) {
      assert.ok(
        source.includes(use),
        `${workflow} must consume lane data instead of repeating ${use}`,
      );
    }
    assert.doesNotMatch(source, /post-pickup-comment:/u);
    assert.doesNotMatch(source, /MESSAGE_PREFIX:/u);
    assert.doesNotMatch(source, /EXCLUDE_COMMENT_ID:/u);
  }
});

test('workers share one lifecycle skeleton around their adapter step', async () => {
  const sources = await workflowSources();
  for (const workflow of workerWorkflowNames) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    const steps = stepBlocks(source);
    const adapter = agentAdapterStep(steps, workflow);
    const checkout = steps.find((step) =>
      stepField('uses', 'actions/checkout@v7').test(step.source),
    );
    assert.ok(checkout, `${workflow} must check out its trusted workflow ref`);
    assertOrderedSteps(steps, workflow, [
      checkout.name,
      'Snapshot post-agent enforcement scripts',
      'Assert required repo variables are set',
      'Verify broker binding',
      'Mint agent token',
      'Claim the issue as the agent fleet',
      'Shared agent setup',
      'Prepare dispatch context',
      'Start telemetry sidecar',
      adapter.name,
      'Finalize telemetry sidecar',
      'Verify a deliverable exists',
      'Determine failure reason',
      'Report failure on the issue',
      'Return completion observation to the broker',
    ]);

    const snapshot = actionStep(
      steps,
      workflow,
      './.github/actions/snapshot-enforcement-scripts',
    );
    const repoVars = actionStep(
      steps,
      workflow,
      './.github/actions/assert-repo-vars',
    );
    const preflight = namedStep(steps, workflow, 'Verify broker binding');
    const mint = actionStep(
      steps,
      workflow,
      './.github/actions/mint-agent-token',
    );
    const claim = actionStep(steps, workflow, './.github/actions/claim-issue');
    const telemetryStart = actionStep(
      steps,
      workflow,
      './.github/actions/telemetry-start',
    );
    const telemetryFinalize = namedStep(
      steps,
      workflow,
      'Finalize telemetry sidecar',
    );
    const deliverable = namedStep(
      steps,
      workflow,
      'Verify a deliverable exists',
    );
    const failureReason = namedStep(
      steps,
      workflow,
      'Determine failure reason',
    );
    const failureReport = namedStep(
      steps,
      workflow,
      'Report failure on the issue',
    );
    const completion = namedStep(
      steps,
      workflow,
      'Return completion observation to the broker',
    );

    assert.match(checkout.source, stepField('uses', 'actions/checkout@v7'));
    assert.match(
      snapshot.source,
      stepField('uses', './.github/actions/snapshot-enforcement-scripts'),
    );
    assert.match(
      repoVars.source,
      stepField('uses', './.github/actions/assert-repo-vars'),
    );
    assert.match(
      preflight.source,
      stepField('uses', './.github/actions/dispatch-broker'),
    );
    assert.match(preflight.source, stepField('operation', 'preflight', 10));
    assert.match(
      mint.source,
      stepField('uses', './.github/actions/mint-agent-token'),
    );
    assert.match(
      claim.source,
      stepField('uses', './.github/actions/claim-issue'),
    );
    assert.doesNotMatch(claim.source, /post-pickup-comment:/u);
    assert.doesNotMatch(claim.source, /message-prefix:/u);

    assert.match(telemetryStart.source, stepField('if', 'always()'));
    assert.match(telemetryFinalize.source, stepField('if', 'always()'));
    assert.match(
      telemetryFinalize.source,
      stepField('continue-on-error', 'true'),
    );
    assert.match(
      telemetryFinalize.source,
      stepField(
        'run',
        'bash "$RUNNER_TEMP/trusted-actions/telemetry-finalize/telemetry-finalize.sh"',
      ),
    );
    assert.match(deliverable.source, stepField('if', 'success()'));
    assert.match(
      deliverable.source,
      stepField(
        'run',
        'bash "$RUNNER_TEMP/trusted-actions/verify-deliverable/verify-deliverable.sh"',
      ),
    );
    assert.match(failureReason.source, stepField('id', 'failure-reason'));
    assert.match(
      failureReason.source,
      stepField('if', 'failure() || cancelled()'),
    );
    assert.match(
      failureReport.source,
      stepField('if', 'failure() || cancelled()'),
    );
    assert.match(
      failureReport.source,
      stepField('REASON', '${{ steps.failure-reason.outputs.reason }}', 10),
    );
    assert.match(
      failureReport.source,
      stepField(
        'run',
        'bash "$RUNNER_TEMP/trusted-actions/report-failure/report-failure.sh"',
      ),
    );
    assert.match(completion.source, stepField('if', 'always()'));
    assert.match(completion.source, stepField('continue-on-error', 'true'));
    assert.match(
      completion.source,
      stepField('uses', './.github/actions/dispatch-broker'),
    );
    assert.match(
      completion.source,
      stepField('operation', 'completion-callback', 10),
    );
    assert.match(
      completion.source,
      stepField('worker-workflow', '${{ env.WORKER_WORKFLOW }}', 10),
    );
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
