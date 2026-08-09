import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  excludedPullRequestAuthors,
  formatDispatchMarker,
  formatRouterGroupMarker,
  PIPELINE_CONTRACTS,
} from '@agent-lcars/dispatch-contracts';
import {
  RECONCILE_OIDC_AUDIENCE,
  RECONCILE_WORKFLOW_PATH,
} from '@agent-lcars/dispatch-reconcile';
import { test } from 'vitest';

import { agentWorkerPipelines, workerWorkflow } from './github-api.js';

// Resolved from this file's own location, not from `process.cwd()`. These
// assertions are about workflow YAML that lives at the workspace root while
// the suite now runs with the project directory as its working directory --
// a cwd-relative path silently pointed at apps/dispatch-broker/.github.
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const workflowsDirectory = path.join(workspaceRoot, '.github/workflows');
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

function jobBlock(source, workflow, jobName) {
  const startPattern = new RegExp(`^ {2}${escapeRegex(jobName)}:\\s*$`, 'mu');
  const match = startPattern.exec(source);
  assert.ok(match, `${workflow} must declare ${jobName}`);
  const remainder = source.slice(match.index);
  const nextJobOffset = remainder.slice(1).search(/^ {2}[A-Za-z0-9_-]+:\s*$/mu);
  return nextJobOffset === -1
    ? remainder
    : remainder.slice(0, nextJobOffset + 1);
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

test('unsupported queue policies are absent and serialized jobs do not cancel', async () => {
  for (const workflow of await workflowSources()) {
    const queues = [
      ...workflow.source.matchAll(/^\s*queue:\s*(\S+)\s*$/gmu),
    ].map((match) => match[1]);
    assert.deepEqual(
      queues,
      [],
      `${workflow.name} declares an unsupported queue policy`,
    );
    if (['agent-router.yml', 'codex.yml'].includes(workflow.name)) {
      assert.match(workflow.source, /^\s*cancel-in-progress:\s*false\s*$/mu);
    }
  }
});

test('critical scheduled workflows report one isolated durable alert and recover independently (#722)', async () => {
  const contracts = [
    {
      workflow: 'agent-automerge.yml',
      job: 'alert-scheduled-sweep',
      needs: 'close-orphaned-anchors',
      guard: "always() && github.event_name == 'schedule'",
      status: '${{ needs.close-orphaned-anchors.result }}',
      event: 'schedule',
    },
    {
      workflow: 'bootstrap-canary.yml',
      job: 'alert',
      needs: 'bootstrap',
      guard: 'always()',
      status: '${{ needs.bootstrap.result }}',
    },
    {
      workflow: 'dispatch-canary.yml',
      job: 'alert',
      needs: 'canary',
      guard: 'always()',
      status: '${{ needs.canary.result }}',
    },
    {
      workflow: 'deliverable-watchdog.yml',
      job: 'alert',
      needs: 'scan',
      guard: 'always()',
      status: '${{ needs.scan.result }}',
    },
    {
      workflow: 'dispatch-reconcile.yml',
      job: 'alert',
      needs: 'hosted-scan',
      guard: 'always()',
      status: '${{ needs.hosted-scan.result }}',
    },
    {
      workflow: 'label-contract-audit.yml',
      job: 'alert',
      needs: 'audit',
      guard: 'always()',
      status: '${{ needs.audit.result }}',
    },
    {
      workflow: 'opencode-model-canary.yml',
      job: 'alert',
      needs: 'probe',
      guard: 'always()',
      status: '${{ needs.probe.result }}',
    },
    {
      workflow: 'post-deploy-smoke.yml',
      job: 'alert',
      needs: 'smoke',
      guard: "always() && github.event.workflow_run.conclusion == 'success'",
      status: '${{ needs.smoke.result }}',
    },
    {
      workflow: 'webhook-ingress-canary.yml',
      job: 'alert',
      needs: 'probe',
      guard: 'always()',
      status: '${{ needs.probe.result }}',
    },
    {
      workflow: 'rerun-infra-killed-runs.yml',
      job: 'alert',
      needs: 'scan',
      guard: 'always()',
      status: '${{ needs.scan.result }}',
    },
  ];

  for (const contract of contracts) {
    const source = await fs.readFile(
      path.join(workflowsDirectory, contract.workflow),
      'utf8',
    );
    const alertJob = jobBlock(source, contract.workflow, contract.job);
    assert.match(alertJob, stepField('needs', contract.needs, 4));
    assert.match(alertJob, stepField('if', contract.guard, 4));
    assert.match(alertJob, /^ {4}continue-on-error:\s+true$/mu);
    assert.match(alertJob, /^ {4}runs-on:\s+ubuntu-latest$/mu);
    assert.match(alertJob, /^ {6}actions:\s+read$/mu);
    assert.match(alertJob, /^ {6}contents:\s+read$/mu);
    assert.match(alertJob, /^ {6}issues:\s+write$/mu);
    assert.match(alertJob, /^ {8}uses:\s+actions\/checkout@v7$/mu);
    assert.match(
      alertJob,
      /^ {8}uses:\s+\.\/\.github\/actions\/canary-alert$/mu,
    );
    assert.match(alertJob, stepField('token', '${{ github.token }}', 10));
    assert.match(alertJob, stepField('workflow-status', contract.status, 10));
    assert.match(alertJob, stepField('workflow-file', contract.workflow, 10));
    if (contract.event) {
      assert.match(alertJob, stepField('workflow-event', contract.event, 10));
    } else {
      assert.doesNotMatch(alertJob, /^ {10}workflow-event:/mu);
    }
    assert.match(
      alertJob,
      stepField('maintainer', '${{ vars.MAINTAINER_LOGIN }}', 10),
    );
  }
});

test('the webhook ingress canary proves App delivery without dispatching a worker (#796)', async () => {
  const workflow = 'webhook-ingress-canary.yml';
  const source = await fs.readFile(
    path.join(workflowsDirectory, workflow),
    'utf8',
  );
  const probe = jobBlock(source, workflow, 'probe');
  assert.match(source, /^ {2}schedule:$/mu);
  assert.match(source, /^ {2}workflow_dispatch:$/mu);
  assert.match(source, /^concurrency:$/mu);
  assert.match(source, /^ {2}group:\s+webhook-ingress-canary-run$/mu);
  assert.match(probe, /^ {4}runs-on:\s+ubuntu-latest$/mu);
  assert.match(probe, /^ {6}contents:\s+read$/mu);
  assert.match(probe, /^ {6}id-token:\s+write$/mu);
  assert.match(probe, /^ {6}issues:\s+write$/mu);
  assert.match(
    probe,
    /^ {8}uses:\s+\.\/\.github\/actions\/run-webhook-ingress-canary$/mu,
  );
  assert.match(probe, /secrets\.AGENT_LCARS_PRIVATE_KEY/u);
  assert.doesNotMatch(
    source,
    /agent-router\.yml|AGENT_RUNNER_LABEL|agent-dispatch-canary\.yml|claude\.yml|codex\.yml|opencode\.yml/u,
  );

  const implementation = await fs.readFile(
    path.join(
      workspaceRoot,
      'apps/dispatch-broker/src/webhook-ingress-canary/run.ts',
    ),
    'utf8',
  );
  assert.match(implementation, /\/app\/hook\/deliveries/u);
  assert.match(implementation, /WEBHOOK_INGRESS_PROBE_URL/u);
  assert.match(implementation, /WEBHOOK_INGRESS_CANARY_OIDC_AUDIENCE/u);
  assert.match(implementation, /DISPATCH_LABELS/u);
  assert.doesNotMatch(
    implementation,
    /agent-router\.yml|AGENT_RUNNER_LABEL|workerWorkflow\(/u,
  );

  const action = await fs.readFile(
    path.join(
      workspaceRoot,
      '.github/actions/run-webhook-ingress-canary/action.yml',
    ),
    'utf8',
  );
  assert.match(action, /probe_bundle_missing/u);
  await fs.access(
    path.join(
      workspaceRoot,
      '.github/actions/run-webhook-ingress-canary/dist/run.mjs',
    ),
  );
});

test('the deliverable watchdog observes stale agent PRs without broker or merge authority (#721)', async () => {
  const workflow = 'deliverable-watchdog.yml';
  const source = await fs.readFile(
    path.join(workflowsDirectory, workflow),
    'utf8',
  );
  const scan = jobBlock(source, workflow, 'scan');
  assert.match(scan, /^ {4}runs-on:\s+ubuntu-latest$/mu);
  assert.match(scan, /^ {6}checks:\s+read$/mu);
  assert.match(scan, /^ {6}contents:\s+read$/mu);
  assert.match(scan, /^ {6}issues:\s+write$/mu);
  assert.match(scan, /^ {6}pull-requests:\s+read$/mu);
  assert.doesNotMatch(scan, /^ {6}(actions|id-token):\s+write$/mu);
  assert.doesNotMatch(source, /dispatch-broker|gh pr (merge|update-branch)/u);
  assert.match(source, /^\s+cancel-in-progress:\s+false$/mu);

  const action = actionStep(
    stepBlocks(scan),
    workflow,
    './.github/actions/deliverable-watchdog',
  );
  assert.match(
    action.source,
    stepField('agent-bot-logins', '${{ vars.AGENT_BOT_LOGINS }}', 10),
  );
  assert.match(
    action.source,
    stepField('maintainer', '${{ vars.MAINTAINER_LOGIN }}', 10),
  );
  assert.match(action.source, stepField('required-check', 'Verify', 10));
  assert.match(action.source, stepField('stale-hours', "'6'", 10));

  const actionSource = await fs.readFile(
    path.join(workspaceRoot, '.github/actions/deliverable-watchdog/action.yml'),
    'utf8',
  );
  assert.match(
    actionSource,
    /run:\s+node "\$GITHUB_ACTION_PATH\/dist\/main\.mjs"/u,
  );
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
          'apps/dispatch-broker/src/broker.ts (beginDispatch/acceptIntent) now ' +
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
  // broker.js's completeRun/markDispatchRejected. The old in-workflow
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

test('agent workflows put the pnpm store on the autoscaler-managed workdir', async () => {
  const sources = await workflowSources();
  for (const workflow of ['claude.yml', 'codex.yml', 'opencode.yml']) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    assert.equal(
      laneValue(source, workflow, 'npm_config_store_dir'),
      '/home/runner/_work/.pnpm-store',
      `${workflow} must use the pnpm store pruned by the idle-host sweep`,
    );
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
  assert.match(source, /timeout-minutes:\s*120\s*$/mu);
  assert.match(source, /^\s+agent:\s+build\s*$/mu);
  assert.match(source, /^\s+variant:\s+minimal\s*$/mu);
  assert.match(source, /first durable\s+artifact/u);
  assert.match(source, /exactly one\s+of: PR <url>, REVIEW/u);
  assert.match(source, /Authenticate published OpenCode action API calls/u);
  assert.match(
    source,
    /api\.github\.com\/repos\/anomalyco\/opencode\/releases\/latest/u,
  );
  assert.match(source, /Authorization: Bearer \$\{GITHUB_TOKEN/u);
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
  for (const pipeline of agentWorkerPipelines) {
    const workflow = workerWorkflow(pipeline);
    const contract = PIPELINE_CONTRACTS[pipeline];
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    assert.deepEqual(dispatchInputNames(source), expectedInputs);
    assert.equal(
      /^run-name:\s+(.+)$/mu.exec(source)?.[1],
      "'#${{ inputs.issue }}: " +
        `${contract.runNameLabel} ` +
        `${formatDispatchMarker({
          generation: '${{ inputs.broker_generation }}',
          intentId: '${{ inputs.broker_intent_id }}',
        })}'`,
      `${workflow} must derive its run name from canonical inputs and lane data`,
    );
    assert.doesNotMatch(source, /github\.event\.inputs/u);
    assert.doesNotMatch(source, /missing=""/u);
    assert.equal(
      laneValue(source, workflow, 'AGENT_NAME'),
      contract.displayName,
      `${workflow} must declare its display name as lane data`,
    );
    assert.equal(
      laneValue(source, workflow, 'WORKER_WORKFLOW'),
      contract.workflowFile,
      `${workflow} must identify itself to the broker`,
    );
    assert.equal(
      laneValue(source, workflow, 'EXPECTED_COMMENT_LOGIN'),
      contract.botLogin,
      `${workflow} must declare its bot login as lane data`,
    );
    assert.equal(
      laneValue(source, workflow, 'EXCLUDE_PR_AUTHOR'),
      excludedPullRequestAuthors(pipeline)[0],
      `${workflow} must declare its excluded PR author as lane data`,
    );
    assert.equal(
      laneValue(source, workflow, 'AGENT_LABEL'),
      contract.label,
      `${workflow} must declare its agent:* label as lane data`,
    );
    assert.equal(
      laneValue(source, workflow, 'REDISPATCH_COMMAND'),
      contract.redispatchCommand,
      `${workflow} must declare its redispatch command as lane data`,
    );
    assert.ok(
      laneValue(source, workflow, 'AGENT_GIT_LOGIN'),
      `${workflow} must declare nonempty AGENT_GIT_LOGIN lane data`,
    );
    for (const use of [
      'agent-login: ${{ env.AGENT_GIT_LOGIN }}',
      'agent: ${{ env.AGENT_NAME }}',
      'EXPECTED_COMMENT_LOGIN: ${{ env.EXPECTED_COMMENT_LOGIN }}',
      'EXCLUDE_PR_AUTHOR: ${{ env.EXCLUDE_PR_AUTHOR }}',
      // NO_DELIVERABLE_REASON (post-agent-gates.sh's lane-owned input)
      // substitutes both of these via GH Actions expression syntax rather
      // than bash string interpolation now that the reason text is
      // rendered by the caller's own YAML, not composed inside a `run:`
      // script -- see "each lane's own no-deliverable wording..." below
      // for the exact per-lane text this produces.
      '${{ env.AGENT_LABEL }}',
      '${{ env.REDISPATCH_COMMAND }}',
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
      'Start telemetry sidecar',
      'Prepare current dispatch brief and runtime deadline',
      adapter.name,
      'Run post-agent gates',
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
    // Found by name, not by `actionStep`'s uses-scan: since #645 Phase 3
    // every worker also mints a second, narrowly-scoped token (see "Mint
    // CI-rerun token") from this same composite action, so a scan for
    // "the one step using this action" no longer identifies a unique
    // step. The uniquely-named "Mint agent token" step is still the
    // identity/push-credential mint this assertion is about.
    const mint = namedStep(steps, workflow, 'Mint agent token');
    const claim = actionStep(steps, workflow, './.github/actions/claim-issue');
    const telemetryStart = actionStep(
      steps,
      workflow,
      './.github/actions/telemetry-start',
    );
    const postAgentGates = namedStep(steps, workflow, 'Run post-agent gates');

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

    // Run post-agent gates (#645 Phase 3): the single entry point that
    // replaces the four hand-copied telemetry-finalize/verify-deliverable/
    // determine-failure-reason/report-failure steps. It must run
    // unconditionally (mirroring telemetry-finalize's own if: always()) and
    // must NOT carry continue-on-error -- that flag on the four original
    // steps applied only to telemetry-finalize; verify-deliverable and
    // report-failure both need their own failure to fail the job, and
    // post-agent-gates.sh reproduces that internally via its own exit code
    // (see its header comment), which continue-on-error at the step level
    // would silently swallow.
    assert.match(postAgentGates.source, stepField('if', 'always()'));
    assert.match(postAgentGates.source, stepField('id', 'post_agent_gates'));
    assert.doesNotMatch(postAgentGates.source, /continue-on-error/u);
    assert.match(
      postAgentGates.source,
      stepField(
        'run',
        'bash "$RUNNER_TEMP/trusted-actions/post-agent-gates/post-agent-gates.sh"',
      ),
    );
    // Every env var post-agent-gates.sh requires, wired from exactly the
    // same sources the four original steps used -- same tokens (github.token,
    // deliberately, not the minted App token), same JOB_STATUS/NO_DELIVERABLE
    // propagation inputs.
    for (const [envField, envValue] of [
      ['GH_TOKEN', '${{ github.token }}'],
      ['AGENT', '${{ env.AGENT_NAME }}'],
      ['REPO', '${{ github.repository }}'],
      ['SERVER_URL', '${{ github.server_url }}'],
      ['RUN_ID', '${{ github.run_id }}'],
      ['ISSUE', '${{ inputs.issue }}'],
      ['STARTED_AT', "${{ steps.agent-setup.outputs['started-at'] }}"],
      ['MODE', '${{ inputs.mode }}'],
      ['EXPECTED_COMMENT_LOGIN', '${{ env.EXPECTED_COMMENT_LOGIN }}'],
      ['EXCLUDE_PR_AUTHOR', '${{ env.EXCLUDE_PR_AUTHOR }}'],
      ['JOB_STATUS', '${{ job.status }}'],
      ['MAINTAINER', '${{ vars.MAINTAINER_LOGIN }}'],
      [
        'WRITER_CREDENTIALS_FILE',
        "${{ steps.telemetry-start.outputs['credentials-file-path'] }}",
      ],
    ]) {
      assert.match(
        postAgentGates.source,
        stepField(envField, envValue, 10),
        `${workflow}'s "Run post-agent gates" step must pass ${envField} to the orchestrator`,
      );
    }
    // NO_DELIVERABLE_REASON is lane-owned data (each lane's own wording,
    // asserted verbatim in the dedicated per-lane test below) -- just check
    // the shape (a folded block scalar) and that it substitutes THIS lane's
    // own AGENT_LABEL/REDISPATCH_COMMAND rather than a hardcoded literal.
    assert.match(
      postAgentGates.source,
      new RegExp(`^ {10}NO_DELIVERABLE_REASON:\\s*>-\\s*$`, 'mu'),
    );
    assert.match(postAgentGates.source, /`\$\{\{ env\.AGENT_LABEL \}\}`/u);
    assert.match(
      postAgentGates.source,
      /`\$\{\{ env\.REDISPATCH_COMMAND \}\}`/u,
    );

    assert.doesNotMatch(
      source,
      /^ {6}- name:\s+Return completion observation to the broker\s*$/mu,
      `${workflow} must not mint completion authority inside the untrusted worker job`,
    );
  }

  const snapshotAction = await fs.readFile(
    path.join(
      workspaceRoot,
      '.github/actions/snapshot-enforcement-scripts/action.yml',
    ),
    'utf8',
  );
  assert.match(snapshotAction, /^ {6}dispatch-broker\s*$/mu);
});

test('every agent lane delegates completion to the shared isolated GitHub-hosted finalizer (#639/#736)', async () => {
  const sources = await workflowSources();
  for (const pipeline of agentWorkerPipelines) {
    const workflow = workerWorkflow(pipeline);
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    assert.doesNotMatch(
      source,
      /^ {4}outputs:\s*$/mu,
      `${workflow} must not expose worker-controlled outputs to the isolated finalizer`,
    );
    assert.match(source, /^ {2}fallback-finalize:\s*$/mu);
    assert.match(source, new RegExp(`^ {4}needs:\\s+${pipeline}\\s*$`, 'mu'));
    assert.match(
      source,
      /^ {4}if:\s+always\(\) && github\.event_name == 'workflow_dispatch' && inputs\.issue != ''\s*$/mu,
      `${workflow}'s isolated finalizer must run after every worker result`,
    );
    assert.match(
      source,
      /^ {4}uses:\s+\.\/\.github\/workflows\/agent-fallback-finalize\.yml\s*$/mu,
    );
    assert.match(source, /^ {6}contents:\s+read\s*$/mu);
    assert.match(source, /^ {6}actions:\s+read\s*$/mu);
    assert.match(source, /^ {6}id-token:\s+write\s*$/mu);
    assert.match(source, /^ {6}issues:\s+write\s*$/mu);
    assert.match(source, /^ {6}pull-requests:\s+read\s*$/mu);
    assert.match(
      source,
      new RegExp(
        `^ {6}worker-result:\\s+\\$\\{\\{ needs\\.${pipeline}\\.result \\}\\}\\s*$`,
        'mu',
      ),
    );
    assert.match(source, /^ {6}mode:\s+\$\{\{ inputs\.mode \}\}\s*$/mu);
    assert.match(source, /^ {6}runbook:\s+\$\{\{ inputs\.runbook \}\}\s*$/mu);
    assert.match(
      source,
      /^ {6}fleet-login:\s+\$\{\{ vars\.AGENT_FLEET_LOGIN \}\}\s*$/mu,
    );
    assert.doesNotMatch(source, /^ {4}secrets:\s+inherit\s*$/mu);
    if (pipeline === 'claude') {
      assert.match(
        source,
        /^ {6}CLAUDE_CODE_OAUTH_TOKEN:\s+\$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}\s*$/mu,
      );
    } else {
      assert.doesNotMatch(source, /CLAUDE_CODE_OAUTH_TOKEN/u);
    }
    assert.doesNotMatch(
      source,
      new RegExp(`needs\\.${pipeline}\\.outputs`, 'u'),
      `${workflow} must pass no worker-controlled output across the finalizer boundary`,
    );
  }

  const fallbackSource = await fs.readFile(
    path.join(workflowsDirectory, 'agent-fallback-finalize.yml'),
    'utf8',
  );
  assert.match(fallbackSource, /^ {2}workflow_call:\s*$/mu);
  assert.match(fallbackSource, /^ {6}fleet-login:\s*$/mu);
  assert.match(fallbackSource, /^ {4}runs-on:\s+ubuntu-latest\s*$/mu);
  assert.doesNotMatch(fallbackSource, /AGENT_RUNNER_LABEL/u);
  assert.match(fallbackSource, /^ {6}actions:\s+read\s*$/mu);
  assert.match(fallbackSource, /^ {6}id-token:\s+write\s*$/mu);
  assert.match(fallbackSource, /^ {6}pull-requests:\s+read\s*$/mu);
  const finalizeJob = jobBlock(
    fallbackSource,
    'agent-fallback-finalize.yml',
    'finalize',
  );
  assert.match(
    finalizeJob,
    /^ {4}if:\s+inputs\.issue != ''\s*$/mu,
    'the reusable finalizer must admit called workers by their required input; github.event_name remains the caller event inside a reusable workflow',
  );
  assert.doesNotMatch(
    finalizeJob,
    /github\.event_name == 'workflow_call'/u,
    'a reusable workflow must not expect github.event_name to become workflow_call',
  );
  const steps = stepBlocks(fallbackSource);
  assertOrderedSteps(steps, 'agent-fallback-finalize.yml', [
    'Report and park bootstrap-independent failure',
    'Derive trusted completion evidence',
    'Return completion observation to the broker',
    'Preserve failed callback for scheduled reconciliation',
  ]);
  const report = namedStep(
    steps,
    'agent-fallback-finalize.yml',
    'Report and park bootstrap-independent failure',
  );
  assert.match(
    report.source,
    stepField('if', "inputs.worker-result != 'success'"),
  );
  assert.match(report.source, stepField('GH_TOKEN', '${{ github.token }}', 10));
  assert.match(report.source, /agent-lcars:bootstrap-fallback:v1/u);
  assert.match(report.source, /status:needs-human/u);
  assert.match(report.source, /\{labels: \["status:needs-human"\]\}/u);
  assert.match(report.source, /\{assignees: \[\$login\]\}/u);
  assert.doesNotMatch(report.source, /labels\[\]|assignees\[\]|--silent/u);
  const evidence = namedStep(
    steps,
    'agent-fallback-finalize.yml',
    'Derive trusted completion evidence',
  );
  const callback = namedStep(
    steps,
    'agent-fallback-finalize.yml',
    'Return completion observation to the broker',
  );
  const preserveCallback = namedStep(
    steps,
    'agent-fallback-finalize.yml',
    'Preserve failed callback for scheduled reconciliation',
  );
  assert.match(evidence.source, stepField('if', 'always()'));
  assert.match(evidence.source, /actions\/runs\/\$GITHUB_RUN_ID\/jobs/u);
  assert.match(evidence.source, /<!-- attempt-claim:\$\{attempt_id\} -->/u);
  assert.match(evidence.source, /select\(\.conclusion == "failure"\)/u);
  assert.doesNotMatch(evidence.source, /Classify Claude .* readiness/u);
  assert.match(
    evidence.source,
    /Claude's structured execution file lives in the untrusted worker/u,
  );
  assert.match(evidence.source, /\.started_at \/\/ ""/u);
  assert.match(
    evidence.source,
    /status:needs-human[\s\S]*comments\?since=\$started_at[\s\S]*submitted_at >= \$started/u,
    'the isolated finalizer must preserve the trusted gate inference outcomes',
  );
  assert.match(evidence.source, /Omitting unverified lifecycle outcome/u);
  assert.doesNotMatch(
    evidence.source,
    /Could not read trusted worker job metadata[\s\S]{0,200}outcome-kind=startup-failure/u,
  );
  // `${worker_job:-{}}` looks like an empty-object fallback, but Bash parses
  // the first `}` as the parameter-expansion terminator and appends the
  // second one to every populated value. Production g7 proved the result:
  // a 3,101-byte job object reached jq with an unmatched `}` at byte 3,102.
  assert.doesNotMatch(evidence.source, /\$\{worker_job:-\{\}\}/u);
  assert.equal(
    evidence.source.match(/<<<"\$worker_job"/gu)?.length,
    4,
    'every trusted worker-job jq read must consume the exact JSON bytes',
  );
  assert.match(
    evidence.source,
    /Successful dispatch canary lacks its exact comment outcome/u,
  );
  assert.doesNotMatch(
    fallbackSource,
    /post-agent-gates-complete|inputs\.outcome-kind|inputs\.outcome-reference|inputs\.readiness-failure/u,
  );
  assert.doesNotMatch(
    finalizeJob,
    /actions\/checkout|uses:\s+\.\/\.github\/actions/u,
  );
  assert.match(
    callback.source,
    stepField('if', 'always()'),
    'a reporting failure must not skip the hosted completion callback',
  );
  assert.match(callback.source, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/u);
  assert.match(callback.source, /data-binary = "@\$payload_file"/u);
  assert.match(callback.source, /steps\.evidence\.outputs\.outcome-kind/u);
  assert.match(callback.source, /completion-sent=true/u);
  assert.doesNotMatch(callback.source, /dispatch-token[^\n]*argv|set -x/u);
  assert.doesNotMatch(callback.source, /GITHUB_TOKEN|github\.token/u);
  assert.match(
    preserveCallback.source,
    stepField(
      'if',
      "always() && steps.callback.outputs.completion-sent != 'true'",
    ),
  );
  assert.match(
    preserveCallback.source,
    stepField('FLEET_LOGIN', '${{ inputs.fleet-login }}', 10),
  );
  assert.match(preserveCallback.source, /\{assignees: \[\$login\]\}/u);
  assert.match(preserveCallback.source, /for attempt in 1 2 3/u);
  assert.match(preserveCallback.source, /fleet-assignee reconcile sweep/u);
  assert.doesNotMatch(
    preserveCallback.source,
    /labels\[\]|assignees\[\]|--silent/u,
  );
});

test('Claude readiness uses one isolated paid probe and a separate secretless projection (#797)', async () => {
  const workflow = 'agent-fallback-finalize.yml';
  const source = await fs.readFile(
    path.join(workflowsDirectory, workflow),
    'utf8',
  );
  assert.match(source, /^ {2}schedule:\s*$/mu);
  assert.match(source, /^ {2}workflow_dispatch:\s*$/mu);
  assert.match(source, /^ {4}secrets:\s*$/mu);
  assert.match(source, /^ {6}CLAUDE_CODE_OAUTH_TOKEN:\s*$/mu);
  assert.equal(
    source.match(/secrets\.CLAUDE_CODE_OAUTH_TOKEN/gu)?.length,
    1,
    'the OAuth token must be referenced only by the isolated probe job',
  );
  assert.doesNotMatch(source, /secrets:\s+inherit/u);

  const admission = jobBlock(source, workflow, 'claude-probe-admission');
  assert.match(admission, /^ {6}issues:\s+read\s*$/mu);
  assert.doesNotMatch(admission, /issues:\s+write|secrets\./u);
  assert.match(admission, /inputs\.worker-result != 'success'/u);
  assert.match(admission, /lane-readiness:v1:claude/u);
  assert.match(admission, /should-probe=false/u);

  const probe = jobBlock(source, workflow, 'claude-probe');
  assert.match(probe, /^ {4}runs-on:\s+ubuntu-latest\s*$/mu);
  assert.match(probe, /^ {4}concurrency:\s*$/mu);
  assert.match(probe, /^ {6}cancel-in-progress:\s+false\s*$/mu);
  assert.match(probe, /^ {6}contents:\s+read\s*$/mu);
  assert.doesNotMatch(probe, /issues:\s+write|id-token:\s+write/u);
  assert.match(
    probe,
    /uses:\s+anthropics\/claude-code-action\/base-action@c038e4dcdedfbbca18dfb17df35a17e40ded4ddc\s+#/u,
  );
  assert.match(probe, /continue-on-error:\s+true/u);
  assert.match(
    probe,
    /CLAUDE_WORKING_DIR:\s+\$\{\{ runner\.temp \}\}\/claude-readiness-probe/u,
  );
  assert.match(probe, /--max-turns 1/u);
  assert.match(probe, /--setting-sources user/u);
  assert.match(probe, /--tools ""/u);
  assert.match(probe, /operation:\s+classify-claude-readiness/u);
  assert.match(probe, /probe-conclusion:\s+\$\{\{ steps\.probe\.outcome \}\}/u);
  assert.match(probe, /readiness-state == 'unknown'/u);

  const projection = jobBlock(source, workflow, 'claude-probe-project');
  assert.match(projection, /^ {6}issues:\s+write\s*$/mu);
  assert.doesNotMatch(projection, /secrets\./u);
  assert.match(projection, /credential-failure/u);
  assert.match(projection, /healthy/u);
  assert.match(projection, /operation:\s+claude-readiness/u);
  assert.match(
    projection,
    /evidence-url:\s+\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/u,
  );
});

test('workflow-owned assignment mutations use parse-safe JSON bodies (#645)', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-automerge.yml'),
    'utf8',
  );
  const steps = stepBlocks(source);
  const assign = namedStep(
    steps,
    'agent-automerge.yml',
    'Claim the PR as jclaw-bot',
  );

  assert.match(assign.source, /\{assignees: \[\$login\]\}/u);
  assert.match(assign.source, /--method POST --input - >\/dev\/null/u);
  assert.doesNotMatch(assign.source, /assignees\[\]|--silent/u);
});

test('worker agent steps never receive github.token under any name (#645 Phase 3)', async () => {
  // github.token is this job's own control-plane credential -- the exact
  // one dispatch-broker preflight reads before untrusted execution. The
  // post-agent completion client deliberately uses OIDC and never receives
  // this token. The job token carries the workflow's full
  // contents/issues/pull-requests/actions write grant. The agent step runs
  // untrusted, agent-authored code with unrestricted Bash;
  // handing it github.token under ANY env-var name would let that code
  // rewrite the ledger and act as the controller -- exactly what #645
  // forbids. All three workers used to do this via ACTIONS_RERUN_TOKEN
  // (the CI-rerun affordance from agent-protocol.md §8); the fix mints a
  // separate actions:write-only token instead (see "Mint CI-rerun
  // token"). Scan the adapter step's whole source (env: AND with:), not
  // one known variable name, so a differently-named leak still trips
  // this.
  // Three ways this leaks that a naive scan misses, all of which reach the
  // adapter step just as effectively as writing it inline:
  //   - workflow-level or job-level `env:`, which every step inherits;
  //   - `secrets.GITHUB_TOKEN`, the same credential under another context;
  //   - bracket-form context access, e.g. github['token'].
  // A drift guard that only recognises one spelling is a guard against
  // being written the way it was written last time.
  const jobTokenReference =
    /\$\{\{\s*(?:github\s*(?:\.\s*token|\[\s*['"]token['"]\s*\])|secrets\s*(?:\.\s*GITHUB_TOKEN|\[\s*['"]GITHUB_TOKEN['"]\s*\]))\s*\}\}/u;

  const sources = await workflowSources();
  for (const workflow of workerWorkflowNames) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    const steps = stepBlocks(source);
    const adapter = agentAdapterStep(steps, workflow);
    assert.doesNotMatch(
      adapter.source,
      jobTokenReference,
      `${workflow}'s agent step (steps.agent) must never receive the job ` +
        'token under any name or spelling -- use a separately minted, ' +
        'narrowly-scoped credential instead (AGENT_CI_RERUN_TOKEN)',
    );

    // Everything above the first step is workflow- and job-level config;
    // an `env:` entry there is inherited by every step including the
    // adapter, so a leak placed here would never appear in the step's own
    // source.
    assert.match(
      adapter.source,
      /ACTIONS_RERUN_TOKEN:\s+\$\{\{\s*secrets\.AGENT_CI_RERUN_TOKEN\s*\}\}/u,
      `${workflow} must grant the CI-rerun affordance through the ` +
        'dedicated AGENT_CI_RERUN_TOKEN secret. Not github.token, and not ' +
        'a minted App token either -- the latter is genuinely narrow but ' +
        'expires after an hour, and this step can run for two.',
    );

    const firstStep = source.search(/^ {6}- name: /mu);
    const inheritedConfig =
      firstStep === -1 ? source : source.slice(0, firstStep);
    assert.doesNotMatch(
      inheritedConfig,
      jobTokenReference,
      `${workflow} must not expose the job token through workflow- or ` +
        'job-level env:, which the agent step inherits silently',
    );
  }
});

test('router retains only a serialized canary workflow_dispatch path (#798)', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  assert.ok(source.includes(`group: ${expectedGroup}`));
  assert.match(
    source,
    /^\s+group:\s+\$\{\{ steps\.normalize\.outputs\.group \}\}\s*$/mu,
  );
  assert.match(source, /^ {2}workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(source, /^ {2}issues:\s*$/mu);
  assert.doesNotMatch(source, /^ {2}issue_comment:\s*$/mu);
  assert.doesNotMatch(source, /^ {2}pull_request_target:\s*$/mu);
  assert.doesNotMatch(source, /^ {2}pull_request:\s*$/mu);
  assert.match(source, /^\s+pull-requests:\s+write\s*$/mu);
  assert.match(source, /^\s+options:\s+\[canary\]\s*$/mu);
  assert.match(source, /^ {4}if:\s+inputs\.kind == 'canary'\s*$/mu);
  for (const retiredInput of [
    'pipeline',
    'mode',
    'reply',
    'runbook',
    'context',
    'completion_payload',
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`^ {6}${retiredInput}:\\s*$`, 'mu'),
      `agent-router.yml must not restore retired ${retiredInput} input`,
    );
  }
});

test('agent-router.yml scopes id-token: write to the broker job alone, restating every other permission it uses (#645 Phase 6)', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  const brokerSection = source.slice(source.search(/^ {2}broker:\s*$/mu));
  assert.ok(brokerSection, 'agent-router.yml must have a broker job');

  // Job-level `permissions:` replaces the workflow-level block entirely for
  // this job, so broker must restate everything its own steps use.
  const permissionsStart = brokerSection.search(/^\s+permissions:\s*$/mu);
  assert.notEqual(
    permissionsStart,
    -1,
    'broker must declare its own job-level permissions block',
  );
  const concurrencyStart = brokerSection.search(/^\s+concurrency:\s*$/mu);
  assert.notEqual(concurrencyStart, -1);
  const brokerPermissions = brokerSection.slice(
    permissionsStart,
    concurrencyStart,
  );
  assert.match(brokerPermissions, /^\s+contents:\s+read(?:\s+#.*)?$/mu);
  assert.match(brokerPermissions, /^\s+issues:\s+write(?:\s+#.*)?$/mu);
  assert.match(brokerPermissions, /^\s+pull-requests:\s+write(?:\s+#.*)?$/mu);
  assert.match(brokerPermissions, /^\s+actions:\s+write(?:\s+#.*)?$/mu);
  assert.match(brokerPermissions, /^\s+id-token:\s+write(?:\s+#.*)?$/mu);

  // normalize must not gain id-token: write: the only id-token: write in
  // the whole file is the one just proven to sit inside broker's own
  // job-level block, not the workflow-level block normalize inherits.
  assert.equal(
    [...source.matchAll(/^\s+id-token:\s+write\s*$/gmu)].length,
    1,
    'id-token: write must appear exactly once, scoped to the broker job',
  );
});

test('agent-router.yml gates dispatch-storage GCP auth on shadow or authority mode and wires the token/mode into the broker action (#736)', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  const steps = stepBlocks(source);
  const auth = namedStep(
    steps,
    'agent-router.yml',
    'Authenticate to GCP for dispatch storage',
  );
  assert.match(auth.source, stepField('id', 'gcp-auth'));
  assert.match(
    auth.source,
    stepField(
      'if',
      "vars.DISPATCH_STORAGE_MODE == 'shadow' || vars.DISPATCH_STORAGE_MODE == 'authority'",
    ),
    'the auth step must be conditional on a storage-writing mode, so an off run mints no token at all',
  );
  assert.match(auth.source, stepField('uses', 'google-github-actions/auth@v3'));
  assert.match(
    auth.source,
    stepField(
      'workload_identity_provider',
      '${{ vars.GCP_DISPATCH_BROKER_WIF_PROVIDER }}',
      10,
    ),
  );
  assert.match(
    auth.source,
    stepField('service_account', '${{ vars.GCP_DISPATCH_BROKER_SA }}', 10),
  );
  assert.match(auth.source, stepField('token_format', 'access_token', 10));

  const brokerStep = namedStep(
    steps,
    'agent-router.yml',
    'Apply serialized broker transition',
  );
  assert.match(
    brokerStep.source,
    stepField('DISPATCH_STORAGE_MODE', '${{ vars.DISPATCH_STORAGE_MODE }}', 10),
  );
  assert.match(
    brokerStep.source,
    stepField(
      'DISPATCH_STORAGE_TOKEN',
      '${{ steps.gcp-auth.outputs.access_token }}',
      10,
    ),
  );
  assert.match(
    brokerStep.source,
    stepField(
      'DISPATCH_FIRESTORE_DATABASE_ID',
      '${{ vars.DISPATCH_FIRESTORE_DATABASE_ID }}',
      10,
    ),
  );
  assert.match(
    brokerStep.source,
    stepField(
      'DISPATCH_AUTHORITY_EPOCH',
      '${{ vars.DISPATCH_AUTHORITY_EPOCH }}',
      10,
    ),
  );
  assert.match(
    brokerStep.source,
    stepField('GCP_PROJECT_ID', '${{ vars.GCP_PROJECT_ID }}', 10),
  );

  assertOrderedSteps(steps, 'agent-router.yml', [auth.name, brokerStep.name]);
});

test('agent-router carries workflow-dispatch PR identity into the broker (#736)', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  assert.match(
    source,
    /^\s+is-pr:\s+\$\{\{ steps\.normalize\.outputs\.is-pr \}\}\s*$/mu,
  );
  assert.match(
    source,
    /^\s+ANCHOR_IS_PR:\s+\$\{\{ needs\.normalize\.outputs\.is-pr \}\}\s*$/mu,
  );
});

test('canary router run-name embeds the router-group marker (#545/#798)', async () => {
  // findConflictingRouterRun (github-api.mjs) identifies a conflicting
  // in-progress agent-router.yml run by matching this marker on the
  // reliable run listing instead of fetching each candidate's unreliable
  // concurrency_groups sub-resource. It must be derived from the shared
  // formatter, not a second hand-written copy of the same literal -- follow
  // how the assertion above already pins worker run-names to
  // formatDispatchMarker.
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  const marker = formatRouterGroupMarker({
    repositoryId: '${{ github.repository_id }}',
    issue: '${{ inputs.issue }}',
  });
  assert.ok(
    source.includes(marker),
    'agent-router.yml run-name must embed the router-group marker via ' +
      'formatRouterGroupMarker and the same canonical canary issue input.',
  );
});

test('the canary-only router is independent of the retired self-hosted control pool (#798)', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  assert.equal(
    (source.match(/^\s+runs-on:\s+ubuntu-latest\s*$/gmu) ?? []).length,
    2,
  );
  assert.doesNotMatch(
    source,
    /CONTROL_PLANE_RUNNER_LABEL|DEFAULT_RUNNER_LABEL|CI_RUNNER_LABEL/u,
  );
});

test('all reconciliation runs through the OIDC-authenticated hosted service with no Action fallback (#736/#798)', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, path.basename(RECONCILE_WORKFLOW_PATH)),
    'utf8',
  );
  assert.ok(source.includes(`RECONCILE_AUDIENCE: ${RECONCILE_OIDC_AUDIENCE}`));
  assert.match(source, /^ {2}hosted-scan:\s*$/mu);
  assert.match(source, /^ {4}runs-on:\s+ubuntu-latest\s*$/mu);
  assert.match(source, /^ {6}id-token:\s+write\s*$/mu);
  assert.match(source, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/u);
  assert.match(source, /ACTIONS_ID_TOKEN_REQUEST_URL/u);
  assert.match(source, /\/api\/control-plane\/reconcile/u);
  assert.doesNotMatch(source, /secrets\./u);

  assert.doesNotMatch(source, /action-fallback|CONTROL_PLANE_RUNNER_LABEL/u);
  assert.doesNotMatch(source, /^\s+operation:\s+reconcile\s*$/mu);
  assert.doesNotMatch(source, /^\s+transport:\s*$/mu);
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
  // No secret of any kind -- no model credential and no App token mint.
  // Authority preflight uses only repo-configured WIF to mint a short-lived
  // Firestore reader token before any untrusted code runs.
  assert.doesNotMatch(source, /secrets\./u);
  assert.match(source, /^\s+id-token:\s+write\s*$/mu);
  assert.match(
    source,
    /uses:\s*\.\/\.github\/actions\/snapshot-enforcement-scripts/u,
    'the canary must snapshot the same trusted finalizer used by real workers',
  );
  assert.match(
    source,
    /run:\s+bash "\$RUNNER_TEMP\/trusted-actions\/verify-deliverable\/verify-deliverable\.sh"/u,
    'the canary must exercise exact deliverable validation from the trusted snapshot',
  );
  assert.match(source, /<!-- attempt-claim:\$ATTEMPT_ID -->/u);
  assert.doesNotMatch(
    source,
    /needs\.canary\.outputs|outcome_kind:\s*\$\{\{/u,
    'the canary must not pass its output file across the isolated boundary',
  );
  // Completion is delegated to the same isolated reusable finalizer as the
  // real workers, so the canary job itself cannot mint an accepted callback.
  assert.match(source, /^ {2}completion-finalize:\s*$/mu);
  assert.match(source, /^ {4}if:\s+always\(\)/mu);
  assert.match(
    source,
    /^ {4}uses:\s+\.\/\.github\/workflows\/agent-fallback-finalize\.yml\s*$/mu,
  );
  assert.match(
    source,
    /^ {6}fleet-login:\s+\$\{\{ vars\.AGENT_FLEET_LOGIN \}\}\s*$/mu,
  );
  assert.doesNotMatch(source, /operation:\s*completion-callback/u);
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
    assert.match(
      source,
      /^\s+timeout-minutes:\s+15\s*$/mu,
      `${workflow} must retain five minutes beyond the hosted 10-minute ledger poll for failure parking and teardown (#798)`,
    );
  }
});

test('the bootstrap canary (#645 Phase 3) exercises the self-hosted worker bootstrap sequence without an agent step', async () => {
  // bootstrap-canary.yml proves the half of the worker lifecycle
  // agent-dispatch-canary.yml is structurally incapable of touching: runner
  // allocation from vars.AGENT_RUNNER_LABEL, mint-agent-token,
  // snapshot-enforcement-scripts, and the telemetry sidecar. It must run on
  // the real self-hosted pool (the opposite of the broker canary's own
  // ubuntu-latest requirement) while still never invoking a paid model,
  // mirroring agent-dispatch-canary.yml's own "structurally incapable of a
  // paid or privileged agent" contract for the one dimension that still
  // applies here (no agent adapter, no third-party agent action).
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'bootstrap-canary.yml'),
    'utf8',
  );

  assert.match(
    source,
    /^\s+runs-on:\s+\['\$\{\{ vars\.AGENT_RUNNER_LABEL \}\}'\]\s*$/mu,
    'bootstrap-canary.yml must allocate a runner from the same self-hosted pool claude.yml/codex.yml/opencode.yml use',
  );

  for (const action of [
    './.github/actions/snapshot-enforcement-scripts',
    './.github/actions/mint-agent-token',
    './.github/actions/telemetry-start',
  ]) {
    assert.match(
      source,
      new RegExp(`uses:\\s*${escapeRegex(action)}(?:[\\s@]|$)`, 'mu'),
      `bootstrap-canary.yml must invoke ${action}`,
    );
  }

  // Finalize must run from the pre-agent snapshot via a bare `run:`, never
  // `uses: ./.github/actions/telemetry-finalize` -- that composite's own
  // inner step is continue-on-error: true (telemetry must never fail a
  // real agent run) and therefore always reports green regardless of
  // whether the underlying finalize actually succeeded, which would make
  // this entire canary incapable of catching the failure it exists to
  // catch. See sidecar-lifecycle.sh's own "every failure path ... exits 0"
  // contract and agent-lcars#352's ::warning:: escalation, which this
  // workflow's own verification step reads instead of trusting the
  // composite's exit code.
  assert.doesNotMatch(
    source,
    /uses:\s*\.\/\.github\/actions\/telemetry-finalize(?:[\s@]|$)/u,
    'bootstrap-canary.yml must never invoke telemetry-finalize via `uses:` -- its own continue-on-error: true would make this canary incapable of failing on a real finalize failure',
  );
  assert.match(
    source,
    /run:[^\n]*\n\s*bash "\$RUNNER_TEMP\/trusted-actions\/telemetry-finalize\/telemetry-finalize\.sh"/u,
    'bootstrap-canary.yml must finalize telemetry from the pre-agent snapshot via `run:`',
  );

  // No agent adapter step (the agentAdapterStep helper's own marker: an
  // `id: agent` step) and no published third-party agent action reference
  // -- this canary must stay structurally incapable of a paid dispatch, the
  // same property agent-dispatch-canary.yml's own #307 contract test
  // enforces.
  const steps = stepBlocks(source);
  assert.equal(
    steps.filter((step) => stepField('id', 'agent').test(step.source)).length,
    0,
    'bootstrap-canary.yml must not expose an agent adapter step (steps.agent)',
  );
  assert.doesNotMatch(source, /anthropics\/claude-code-action/u);
  assert.doesNotMatch(source, /anomalyco\/opencode/u);
  assert.doesNotMatch(source, /@openai\/codex/u);

  // Never touches the broker/ledger -- unlike agent-dispatch-canary.yml,
  // this is a standalone infra probe with no issue to claim and nothing for
  // the broker to arbitrate.
  assert.doesNotMatch(source, /\.\/\.github\/actions\/dispatch-broker/u);
  assert.doesNotMatch(source, /\.\/\.github\/actions\/claim-issue/u);

  // Least privilege for the probe itself: only what
  // google-github-actions/auth (inside telemetry-start) needs, plus read
  // access to check out the repo. #722's separate ubuntu-latest alert job
  // has its own job-scoped issues: write grant (pinned by the alert contract
  // above); that must never leak into the bootstrap probe's permissions.
  const jobsStart = source.search(/^jobs:\s*$/mu);
  assert.notEqual(jobsStart, -1);
  const workflowHeader = source.slice(0, jobsStart);
  const bootstrapJob = jobBlock(source, 'bootstrap-canary.yml', 'bootstrap');
  assert.match(workflowHeader, /^permissions:\s*$/mu);
  assert.match(workflowHeader, /^\s+contents:\s+read\s*$/mu);
  assert.match(workflowHeader, /^\s+id-token:\s+write\s*$/mu);
  assert.doesNotMatch(
    `${workflowHeader}\n${bootstrapJob}`,
    /^\s+(issues|pull-requests|actions):\s+write\s*$/mu,
  );
});

test('the OpenCode model canary (#645 Phase 3) probes the exact model opencode.json configures, honestly', async () => {
  // Claude (CLAUDE_CODE_OAUTH_TOKEN, an interactive claude-code-action
  // credential with no documented lightweight validity check) and Codex
  // (CODEX_AUTH_JSON, a ChatGPT subscription credential whose own `codex
  // login status` check -- already run by codex.yml on every real dispatch
  // -- is a local credential-presence check, not a network liveness check)
  // have no honest equivalent, and #645 explicitly forbids faking one for
  // either lane. OpenCode alone resolves through a plain OpenAI-compatible
  // LiteLLM endpoint with a bearer API key, so a direct minimal
  // /v1/chat/completions call is genuinely meaningful -- assert it stays
  // driven by opencode.json's own real configuration, not an independently
  // hardcoded literal that could silently drift from it.
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'opencode-model-canary.yml'),
    'utf8',
  );

  assert.match(
    source,
    /^\s+runs-on:\s+\['\$\{\{ vars\.AGENT_RUNNER_LABEL \}\}'\]\s*$/mu,
    'opencode-model-canary.yml must run on the self-hosted pool -- the LiteLLM endpoint is LAN-only',
  );
  assert.match(source, /secrets\.OPENCODE_LLM_API_KEY/u);

  const steps = stepBlocks(source);
  assert.equal(
    steps.filter((step) => stepField('id', 'agent').test(step.source)).length,
    0,
    'opencode-model-canary.yml must not expose an agent adapter step (steps.agent)',
  );
  assert.doesNotMatch(source, /anthropics\/claude-code-action/u);
  assert.doesNotMatch(source, /anomalyco\/opencode\/github/u);
  assert.doesNotMatch(source, /@openai\/codex/u);

  // Cross-check against opencode.json's own real configuration instead of
  // trusting a second, independently hardcoded literal in the workflow --
  // a future change to the homelab provider's baseURL or model key must
  // fail this test, not silently drift.
  const opencodeConfig = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, 'opencode.json'), 'utf8'),
  );
  const homelabProvider = opencodeConfig.provider?.homelab;
  assert.ok(
    homelabProvider,
    'opencode.json must still declare the homelab provider this canary probes',
  );
  const baseUrl = homelabProvider.options?.baseURL;
  assert.ok(
    baseUrl,
    'opencode.json must declare provider.homelab.options.baseURL',
  );
  const modelKeys = Object.keys(homelabProvider.models ?? {});
  assert.equal(
    modelKeys.length,
    1,
    'expected exactly one model configured under provider.homelab.models',
  );
  const [modelKey] = modelKeys;

  assert.ok(
    source.includes(`${baseUrl}/chat/completions`),
    `opencode-model-canary.yml must call opencode.json's own configured baseURL (${baseUrl}), not an independently hardcoded one`,
  );
  assert.ok(
    source.includes(`"model":"${modelKey}"`),
    `opencode-model-canary.yml must request opencode.json's own configured model key (${modelKey}) -- the same one opencode.yml's own \`model: homelab/${modelKey}\` input drives`,
  );
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

test('post-deploy-smoke.yml isolates successful deploys from skipped workflow triggers (#787)', async () => {
  // `jobs.smoke.if` is evaluated only after a workflow run has entered its
  // workflow-level concurrency group. Without the upstream conclusion in
  // the key, a later skipped Deploy console run can evict the one pending
  // smoke for an earlier successful production deploy before that guard is
  // evaluated.
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'post-deploy-smoke.yml'),
    'utf8',
  );
  assert.match(
    source,
    /^\s+group:\s+post-deploy-smoke-\$\{\{ github\.event\.workflow_run\.conclusion \}\}\s*$/mu,
  );
  assert.doesNotMatch(source, /^\s+group:\s+post-deploy-smoke\s*$/mu);
  assert.match(source, /^\s+cancel-in-progress:\s+false\s*$/mu);
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

test('every worker captures the verified attempt ID via the broker preflight call', async () => {
  // An action output nobody references is inert: the preflight step used to
  // advertise `attempt-id` while no worker gave that step an `id`, so nothing
  // downstream could ever read it and the "propagate an attemptId" contract
  // (#645) was satisfied on paper only. Phase 3 removed the fourth
  // byte-identical hand-copied "Publish attempt identity" step (it runs
  // pre-agent, so unlike the post-agent gates it CAN safely become a
  // composite-action step) and folded it into dispatch-broker/action.yml
  // itself, gated to `operation == 'preflight'`. Assert both halves: the
  // composite does the export exactly once,
  // and every worker's (and the canary's) preflight call still gives that
  // export something to key off (an `id` on the step).
  const brokerActionSource = await fs.readFile(
    path.join(workspaceRoot, '.github/actions/dispatch-broker/action.yml'),
    'utf8',
  );
  assert.match(
    brokerActionSource,
    /^\s+if:\s+inputs\.operation == 'preflight'\s*$/mu,
    'dispatch-broker/action.yml must gate publishing ATTEMPT_ID to the preflight operation',
  );
  assert.match(
    brokerActionSource,
    /ATTEMPT_ID:\s*\$\{\{\s*steps\.run\.outputs\.attempt-id\s*\}\}/u,
    'dispatch-broker/action.yml must publish the SAME attempt ID its own preflight call just verified, not recompose it',
  );
  assert.match(
    brokerActionSource,
    /ATTEMPT_ID=\$ATTEMPT_ID" >> "\$GITHUB_ENV"/u,
    "dispatch-broker/action.yml must export ATTEMPT_ID to the caller job's later steps",
  );

  const sources = await workflowSources();
  const canary = 'agent-dispatch-canary.yml';
  for (const workflow of [...workerWorkflowNames, canary]) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    const steps = stepBlocks(source);

    const preflight = namedStep(steps, workflow, 'Verify broker binding');
    const storageAuth = namedStep(
      steps,
      workflow,
      'Authenticate to authoritative dispatch storage',
    );
    assert.match(
      storageAuth.source,
      stepField('if', "vars.DISPATCH_STORAGE_MODE == 'authority'"),
      `${workflow} must mint a storage token only after authority cutover`,
    );
    assert.match(
      storageAuth.source,
      stepField('uses', 'google-github-actions/auth@v3'),
    );
    assert.match(
      storageAuth.source,
      stepField('service_account', '${{ vars.GCP_DISPATCH_PREFLIGHT_SA }}', 10),
    );
    assert.match(
      preflight.source,
      stepField(
        'DISPATCH_STORAGE_MODE',
        '${{ vars.DISPATCH_STORAGE_MODE }}',
        10,
      ),
    );
    assert.match(
      preflight.source,
      stepField(
        'DISPATCH_STORAGE_TOKEN',
        '${{ steps.worker-storage-auth.outputs.access_token }}',
        10,
      ),
    );
    assert.match(
      preflight.source,
      stepField(
        'DISPATCH_FIRESTORE_DATABASE_ID',
        '${{ vars.DISPATCH_FIRESTORE_DATABASE_ID }}',
        10,
      ),
    );
    assert.match(
      preflight.source,
      stepField('GCP_PROJECT_ID', '${{ vars.GCP_PROJECT_ID }}', 10),
    );
    assertOrderedSteps(steps, workflow, [storageAuth.name, preflight.name]);
    assert.match(
      preflight.source,
      /^\s+id:\s+broker-preflight\s*$/mu,
      `${workflow}'s preflight step needs an id for dispatch-broker/action.yml's own attempt-id output to resolve`,
    );

    assert.doesNotMatch(
      source,
      /Publish attempt identity/u,
      `${workflow} must not hand-copy a "Publish attempt identity" step -- dispatch-broker/action.yml now does this once, internally, on every preflight call`,
    );
  }
});

test('deploy-console.yml uses a workflow-restricted provider for its project-IAM identity', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'deploy-console.yml'),
    'utf8',
  );
  const lines = source.split('\n');
  const authStart = lines.findIndex(
    (line) => line.trim() === '- uses: google-github-actions/auth@v3',
  );
  assert.notEqual(
    authStart,
    -1,
    'deploy-console.yml must retain its GCP auth action',
  );
  const authEnd = lines.findIndex(
    (line, index) => index > authStart && /^\s+- (?:name|uses):/u.test(line),
  );
  assert.notEqual(authEnd, -1, 'the deploy GCP auth block must be bounded');
  const auth = lines.slice(authStart, authEnd).join('\n');
  assert.match(auth, /^\s+id: gcp-auth$/mu);
  assert.match(
    auth,
    stepField(
      'workload_identity_provider',
      '${{ vars.GCP_DEPLOYER_WIF_PROVIDER }}',
      10,
    ),
  );
  assert.match(
    auth,
    stepField('service_account', '${{ vars.GCP_DEPLOYER_SA }}', 10),
  );
});

test('no worker invokes a post-agent gate via `uses:` (#645 Phase 3 security invariant)', async () => {
  // The agent step has unrestricted Bash and can rewrite both the working
  // tree and the runner's own _actions download, so any post-agent gate
  // resolved from disk via `uses:` after that point could execute
  // agent-authored code with the job's token (docs/published-actions.md's
  // "Security: post-agent gates run from a pre-agent snapshot"; see also
  // snapshot-enforcement-scripts/action.yml). Every gate must instead run
  // as `run: bash "$RUNNER_TEMP/trusted-actions/<name>/<name>.sh"` from the
  // pre-agent snapshot. Phase 3's consolidation into one orchestrating
  // script is exactly the kind of change that could accidentally regress
  // this by reaching for `uses:` on the new shared script -- assert it
  // can never happen silently.
  const gateActions = [
    'verify-deliverable',
    'report-failure',
    'telemetry-finalize',
    'post-agent-gates',
  ];
  const sources = await workflowSources();
  const canary = 'agent-dispatch-canary.yml';
  for (const workflow of [...workerWorkflowNames, canary]) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    for (const action of gateActions) {
      assert.doesNotMatch(
        source,
        new RegExp(
          `uses:\\s*\\./\\.github/actions/${action}(?:[\\s@]|$)`,
          'mu',
        ),
        `${workflow} must never invoke ${action} via \`uses:\` -- post-agent gates must run from the pre-agent snapshot via \`run: bash "$RUNNER_TEMP/trusted-actions/...\`, never \`uses:\``,
      );
    }
  }
  for (const workflow of workerWorkflowNames) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.match(
      source,
      /run:\s+bash "\$RUNNER_TEMP\/trusted-actions\/post-agent-gates\/post-agent-gates\.sh"/u,
      `${workflow} must run the shared post-agent gate orchestrator from the pre-agent snapshot`,
    );
  }
  // The canary has no post-agent gate step at all (#307/#645). It may pass
  // the reusable finalizer's completion-proof input, but must not execute
  // the agent-lane gate orchestrator itself.
  const canarySource = sources.find(
    (candidate) => candidate.name === canary,
  )?.source;
  assert.doesNotMatch(
    canarySource,
    /Run post-agent gates|trusted-actions\/post-agent-gates/u,
  );
});

function foldedBlockScalar(source, field, indentation = 10) {
  const pattern = new RegExp(
    `^ {${indentation}}${field}:\\s*>-\\n((?:^ {${
      indentation + 2
    },}\\S.*\\n?)+)`,
    'mu',
  );
  const match = pattern.exec(source);
  assert.ok(match, `expected a folded (">-") block scalar for ${field}`);
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

test("each lane's own no-deliverable wording survives the merge into post-agent-gates.sh verbatim", async () => {
  // claude.yml/codex.yml/opencode.yml each phrased their own
  // "successfully but produced no deliverable" report differently before
  // this refactor (not just AGENT_LABEL/REDISPATCH_COMMAND substitution --
  // genuinely different sentences). The shared post-agent-gates.sh
  // orchestrator stays lane-agnostic by taking NO_DELIVERABLE_REASON as an
  // adapter-style input instead of picking one lane's wording (or
  // templating a lowest-common-denominator version) -- assert each lane's
  // exact original wording (with its own AGENT_LABEL/REDISPATCH_COMMAND
  // substituted via `${{ env.* }}`, exactly as this lane's job-level env
  // already declares those two) survived byte for byte.
  const expected = {
    'claude.yml':
      'The run ended "successfully" but produced **no deliverable** - no PR, no issue close, no status:needs-human label. All of its local work is lost. Re-dispatch by re-adding the `${{ env.AGENT_LABEL }}` label or replying `${{ env.REDISPATCH_COMMAND }}`, and remind it to push early.',
    'codex.yml':
      'The run ended "successfully" but produced **no deliverable** - it may have reasoned to a conclusion internally without ever posting it. Re-dispatch by re-adding the `${{ env.AGENT_LABEL }}` label or replying `${{ env.REDISPATCH_COMMAND }}`, and remind it to push or communicate a final result.',
    'opencode.yml':
      'The run ended "successfully" but produced **no deliverable** - it may have reasoned to a conclusion internally without ever posting it. Re-dispatch by re-adding the `${{ env.AGENT_LABEL }}` label or replying `${{ env.REDISPATCH_COMMAND }}`, and consider whether the prompt needs to be even more explicit for this issue.',
  };
  const sources = await workflowSources();
  for (const [workflow, expectedText] of Object.entries(expected)) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    assert.equal(
      foldedBlockScalar(source, 'NO_DELIVERABLE_REASON'),
      expectedText,
      `${workflow}'s NO_DELIVERABLE_REASON must match its original wording exactly`,
    );
  }
});

test("claude's structured failure scan remains worker-local and is never promoted to trusted readiness evidence", async () => {
  // claude.yml's original "Determine failure reason" step was materially
  // larger than codex.yml's/opencode.yml's: beyond the shared
  // NO_DELIVERABLE check, it inspects Claude Code Action's structured
  // execution file for a turn-budget exhaustion or an expired/invalid OAuth
  // token. That is lane-specific
  // behavior, not duplication -- #645 Phase 3 keeps it as an optional,
  // lane-provided input to the shared orchestrator (FAILURE_LOG_SCAN_SCRIPT)
  // instead of forcing codex/opencode onto it or dropping it.
  const sources = await workflowSources();
  const claudeSource = sources.find(
    (candidate) => candidate.name === 'claude.yml',
  )?.source;
  assert.ok(claudeSource, 'claude.yml is missing');
  assert.match(
    claudeSource,
    /FAILURE_LOG_SCAN_SCRIPT:\s*\$\{\{ runner\.temp \}\}\/trusted-actions\/post-agent-gates\/claude-log-scan\.sh/u,
    'claude.yml must point the shared orchestrator at its own log-scan script',
  );
  assert.match(
    claudeSource,
    /CLAUDE_EXECUTION_FILE:\s*\$\{\{ steps\.agent\.outputs\.execution_file \}\}/u,
    "claude.yml must pass the action's completed structured result to its worker-local failure classification",
  );
  // "Verify Claude run status" remains a worker-local behavior gate. Its
  // structured input is writable by the untrusted worker, so it must never
  // be copied into named readiness steps that the hosted finalizer trusts.
  const claudeSteps = stepBlocks(claudeSource);
  const runStatus = namedStep(
    claudeSteps,
    'claude.yml',
    'Verify Claude run status',
  );
  assert.doesNotMatch(claudeSource, /Classify Claude .* readiness/u);
  assert.match(runStatus.source, stepField('if', 'success()'));
  assert.match(
    runStatus.source,
    stepField(
      'CLAUDE_EXECUTION_FILE',
      '${{ steps.agent.outputs.execution_file }}',
      10,
    ),
  );
  assert.doesNotMatch(runStatus.source, /gh run view/u);
  const claudeAgentStep = agentAdapterStep(claudeSteps, 'claude.yml');
  const agentIndex = claudeSteps.indexOf(claudeAgentStep);
  const runStatusIndex = claudeSteps.indexOf(runStatus);
  const gatesIndex = claudeSteps.findIndex(
    (step) => step.name === 'Run post-agent gates',
  );
  assert.ok(
    agentIndex < runStatusIndex && runStatusIndex < gatesIndex,
    '"Verify Claude run status" must run between the agent step and "Run post-agent gates"',
  );

  for (const workflow of ['codex.yml', 'opencode.yml']) {
    const source = sources.find(
      (candidate) => candidate.name === workflow,
    )?.source;
    assert.ok(source, `${workflow} is missing`);
    assert.doesNotMatch(
      source,
      /FAILURE_LOG_SCAN_SCRIPT/u,
      `${workflow} must not gain claude's log-scan signal -- it never had one`,
    );
    assert.doesNotMatch(source, /Verify Claude run status/u);
    assert.doesNotMatch(source, /Classify Claude .* readiness/u);
  }
});
