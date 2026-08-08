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
      'Prepare dispatch context',
      'Start telemetry sidecar',
      adapter.name,
      'Run post-agent gates',
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

test('worker agent steps never receive github.token under any name (#645 Phase 3)', async () => {
  // github.token is this job's own control-plane credential -- the exact
  // one dispatch-broker uses to read and write the ledger comment (every
  // dispatch-broker step in every worker passes
  // GITHUB_TOKEN: ${{ github.token }}), and it carries the workflow's
  // full contents/issues/pull-requests/actions write grant. The agent
  // step runs untrusted, agent-authored code with unrestricted Bash;
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
  assert.match(brokerPermissions, /^\s+actions:\s+write(?:\s+#.*)?$/mu);
  assert.match(brokerPermissions, /^\s+id-token:\s+write(?:\s+#.*)?$/mu);
  // Broker's own request()/requestOk() call sites (github-api.ts) never
  // touch /pulls/*, only /issues/* and /actions/* -- pull-requests: write
  // (present in the workflow-level block normalize inherits, asserted
  // above) is deliberately not restated here.
  assert.doesNotMatch(brokerPermissions, /pull-requests/u);

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

test('router run-name embeds the router-group marker for every trigger type (#545)', async () => {
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
    issue:
      '${{ github.event.issue.number || github.event.pull_request.number || inputs.issue }}',
  });
  assert.ok(
    source.includes(marker),
    'agent-router.yml run-name must embed the router-group marker via ' +
      'formatRouterGroupMarker, derived from the same issue-number fallback ' +
      'chain (event issue -> event PR -> manual input) the run-name prefix ' +
      'already uses, so it is set unconditionally for every trigger type.',
  );
});

test('router control-plane jobs use the protected self-hosted control pool', async () => {
  const source = await fs.readFile(
    path.join(workflowsDirectory, 'agent-router.yml'),
    'utf8',
  );
  assert.equal(
    (
      source.match(
        /^\s+runs-on:\s+\$\{\{ vars\.CONTROL_PLANE_RUNNER_LABEL \}\}\s*$/gmu,
      ) ?? []
    ).length,
    2,
  );
  assert.doesNotMatch(
    source,
    /ubuntu-latest|DEFAULT_RUNNER_LABEL|CI_RUNNER_LABEL/u,
  );
});

test('scheduled reconciliation runs through the OIDC-authenticated hosted service, with a manual Action fallback (#736)', async () => {
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

  assert.match(source, /^ {2}action-fallback:\s*$/mu);
  assert.match(
    source,
    /^ {4}if:\s+github\.event_name == 'workflow_dispatch' && inputs\.transport == 'action-fallback'\s*$/mu,
  );
  assert.match(
    source,
    /^ {4}runs-on:\s+\$\{\{ vars\.CONTROL_PLANE_RUNNER_LABEL \}\}\s*$/mu,
  );
  assert.match(source, /^\s+operation:\s+reconcile\s*$/mu);
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

  // Least privilege: only what google-github-actions/auth (inside
  // telemetry-start) needs, plus read access to check out the repo.
  assert.match(source, /^permissions:\s*$/mu);
  assert.match(source, /^\s+contents:\s+read\s*$/mu);
  assert.match(source, /^\s+id-token:\s+write\s*$/mu);
  assert.doesNotMatch(
    source,
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
  // itself, gated to `operation == 'preflight'` so a later
  // completion-callback call in the same job never blanks the value back
  // out. Assert both halves: the composite does the export exactly once,
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
  // The canary has no post-agent gates at all (#307/#645) -- assert it
  // stays that way rather than silently growing one.
  const canarySource = sources.find(
    (candidate) => candidate.name === canary,
  )?.source;
  assert.doesNotMatch(canarySource, /post-agent-gates|Run post-agent gates/u);
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

test("claude's extra failure-reason log-scan survives as an adapter-style input, absent from codex/opencode", async () => {
  // claude.yml's original "Determine failure reason" step was materially
  // larger than codex.yml's/opencode.yml's: beyond the shared
  // NO_DELIVERABLE check, it grepped this run's own log for a turn-budget
  // exhaustion or an expired/invalid OAuth token. That is lane-specific
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
  // "Verify Claude run status" (an existing, separate, claude-only gate
  // unrelated to the four steps this refactor consolidates) must still run
  // between the agent step and the merged orchestrator, gated on
  // success() exactly as before -- its own failure must still correctly
  // skip verify-deliverable inside post-agent-gates.sh via JOB_STATUS.
  const claudeSteps = stepBlocks(claudeSource);
  const runStatus = namedStep(
    claudeSteps,
    'claude.yml',
    'Verify Claude run status',
  );
  assert.match(runStatus.source, stepField('if', 'success()'));
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
  }
});
