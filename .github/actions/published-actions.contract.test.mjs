// Guards the published-action surface documented in
// docs/published-actions.md: every Published-tier action's inputs (name,
// requiredness, default) and outputs are asserted against the manifest
// below. A failing run means the surface changed - removing/renaming an
// input or output, flipping optional->required, or changing a default is
// a breaking change for the consumer repos (sprinkles, homelab) that
// resolve these actions cross-repo, and must be a deliberate edit to this
// manifest, called out in review (and, once consumers pin by SHA again,
// a major version bump - see docs/published-actions.md's pinning note).
//
// Line-based parsing, no YAML dependency - the same convention
// dispatch-broker/workflow-contract.test.mjs uses; action.yml files here
// are prettier-formatted two-space YAML, which this parser assumes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const actionsDirectory = path.resolve('.github/actions');

// name -> { inputs: { name: { required, default? } }, outputs: [names] }.
// `default` is asserted only when present here (multi-line defaults are
// asserted by requiredness alone).
const PUBLISHED = {
  'mint-agent-token': {
    inputs: {
      'client-id': { required: true },
      'private-key': { required: true },
      owner: { required: false, default: '' },
      repositories: { required: false, default: '' },
      'permission-issues': { required: false, default: '' },
      'permission-contents': { required: false, default: '' },
      'permission-pull-requests': { required: false, default: '' },
      'permission-actions': { required: false, default: '' },
      // permission-metadata/permission-workflows added deliberately
      // (agent-lcars#868): both additive, unset by default, so an existing
      // consumer that omits them is unaffected. permission-workflows also
      // gates a new preflight step (verify-workflows-grant.sh) that fails
      // the mint before returning a token if the installation has not
      // actually approved `workflows` - see docs/agent-workflow-write-permission.md.
      'permission-metadata': { required: false, default: '' },
      'permission-workflows': { required: false, default: '' },
    },
    // installation-id added deliberately (#868): additive, alongside
    // token/app-slug - an existing consumer that only reads those two is
    // unaffected by an output it never asked for.
    outputs: ['token', 'app-slug', 'installation-id'],
  },
  'claim-issue': {
    inputs: {
      token: { required: true },
      issue: { required: true },
      'claim-login': { required: true },
      'post-pickup-comment': { required: false, default: 'false' },
      agent: { required: false, default: '' },
      'run-url': { required: false, default: '' },
    },
    outputs: ['claimed', 'pickup-comment-id'],
  },
  'agent-setup': {
    inputs: {
      'agent-login': { required: true },
      'shared-cache': { required: false, default: 'auto' },
    },
    outputs: ['started-at'],
  },
  'verify-agent-identity': {
    inputs: {
      token: { required: true },
      agent: { required: true },
      'app-slug': { required: true },
      'expected-app-slug': { required: false, default: 'agent-lcars' },
      'expected-login': { required: false, default: 'agent-lcars[bot]' },
    },
    outputs: [],
  },
  'prepare-agent-dispatch': {
    inputs: {
      token: { required: false, default: '' },
      agent: { required: true },
      // issue/work: additive to Plan 3's native lane (agent-lcars#1527) --
      // issue is now optional (empty for a native work-item dispatch) and
      // `work` carries that dispatch's JSON payload instead. An existing
      // consumer that still always passes `issue` is unaffected.
      issue: { required: false, default: '' },
      work: { required: false, default: '' },
      mode: { required: true },
      reply: { required: false, default: '' },
      runbook: { required: false, default: '' },
      context: { required: false, default: '' },
      // console_url: additive (agent-lcars#1527) -- builds a native work
      // item's anchor.html_url; unused, so harmless, for an issue dispatch.
      console_url: { required: false, default: 'https://lcars.jlapenna.net' },
      'prior-terminal-state': { required: false, default: 'null' },
      'budget-minutes': { required: false, default: '60' },
      'artifact-checkpoint-minutes': { required: false, default: '25' },
      'finalize-checkpoint-minutes': { required: false, default: '45' },
    },
    outputs: ['path', 'protocol-path', 'skills-path', 'skills-digest'],
  },
  'setup-opencode': {
    inputs: { 'github-token': { required: true } },
    outputs: ['version'],
  },
  // Exact-marker only: attempt-id is required, and the legacy inference
  // inputs #4388 once restored (started-at, runbook,
  // expected-comment-login, exclude-pr-author, exclude-comment-id) were
  // deleted once every fleet consumer passed attempt-id (agent-lcars's own
  // lanes, homelab#697, sprinkles#4490). Dropping an input is safe for a
  // moving-@main consumer that still passes it: the runner emits an
  // "Unexpected input(s)" WARNING for unknown composite-action inputs,
  // never an error (actions/runner ActionRunner.cs).
  'verify-deliverable': {
    inputs: {
      token: { required: true },
      agent: { required: true },
      // issue: made optional for Plan 3's native lane (agent-lcars#1527) --
      // empty for a native work-item run, which has no issue/PR anchor and
      // is gated on the PR-marker lookup alone. An existing consumer that
      // still always passes `issue` is unaffected.
      issue: { required: false, default: '' },
      mode: { required: true },
      'attempt-id': { required: true },
    },
    outputs: [],
  },
  // Log-only (#813): the hosted finalizer/orchestrator owns visible
  // failure reporting. The former standalone token/issue/maintainer
  // direct-park inputs (#4388) were retired per maintainer decision
  // 2026-08-17 -- every fleet consumer runs the coupled
  // agent-fallback-finalize.yml, so the direct park had become a
  // redundant second writer. Dropping an input is safe for a
  // moving-@main consumer that still passes it: the runner emits an
  // "Unexpected input(s)" WARNING, never an error.
  'report-failure': {
    inputs: {
      agent: { required: true },
      'message-prefix': { required: false, default: '' },
      reason: { required: false, default: '' },
      'job-status': { required: true },
    },
    outputs: [],
  },
  'merge-live-base': {
    inputs: { 'base-ref': { required: true } },
    outputs: ['original_head', 'live_base', 'tested_head'],
  },
  'assert-repo-vars': {
    inputs: {
      profile: { required: false, default: '' },
      vars: { required: true },
    },
    outputs: [],
  },
  'snapshot-enforcement-scripts': {
    inputs: {
      // Multi-line default (the three enforcement gates); requiredness
      // only.
      actions: { required: false },
    },
    outputs: ['path'],
  },
  // Promoted from Internal when sprinkles retired its independent rebuild
  // of the same self-hosted-cache-guard logic and adopted this copy
  // (fleet survey finding #7, agent-lcars#1206). Contract: `url` empty =>
  // no-op, `write-token` empty => notice-and-skip; fork PRs receive no
  // cache capability.
  'setup-nx-remote-cache': {
    inputs: {
      url: { required: false, default: '' },
      'write-token': { required: false, default: '' },
    },
    outputs: [],
  },
  // Post-deploy smoke verification (#1340 D4): the curl-until-below-500
  // loop from sprinkles deploy.yml's smoke block, published so the
  // fleet's private reimplementations converge. deployment-id/
  // annotate-sha empty => the optional reporting steps no-op.
  'deploy-verify': {
    inputs: {
      url: { required: true },
      'max-attempts': { required: false, default: '10' },
      interval: { required: false, default: '15' },
      'deployment-id': { required: false, default: '' },
      'annotate-sha': { required: false, default: '' },
      token: { required: false, default: '${{ github.token }}' },
    },
    outputs: ['status-code', 'result'],
  },
  // The fleet's one OIDC-mint-then-POST dispatch snippet (#1340 A-R3/D7):
  // consumers are sprinkles' pr-heal/playbook-unstick-prs/visual-refresh/
  // post-deploy-verify and this repo's own dispatch-reconcile. Exactly one
  // of payload/payloads may be set; `payloads` (newline-delimited compact
  // JSON, one POST per line under a single minted token) is the
  // mint-once-reuse batch shape post-deploy-verify's per-issue loop needs,
  // and both empty means a bodyless POST (the reconcile endpoint's shape).
  'request-control-plane': {
    inputs: {
      endpoint: { required: true },
      audience: { required: true },
      payload: { required: false, default: '' },
      payloads: { required: false, default: '' },
      'timeout-seconds': { required: false, default: '60' },
    },
    outputs: [],
  },
};

// Minimal indentation-scoped parser for prettier-formatted action.yml:
// returns { inputs, outputs } in the manifest's shape. Only top-level
// `inputs:`/`outputs:` sections are read; `runs:` ends them.
function parseActionSurface(source) {
  const inputs = {};
  const outputs = [];
  let section = null;
  let currentInput = null;
  for (const line of source.split(/\r?\n/gu)) {
    const top = /^([a-z-]+):\s*$/u.exec(line);
    if (top) {
      section = ['inputs', 'outputs'].includes(top[1]) ? top[1] : null;
      currentInput = null;
      continue;
    }
    if (!section) continue;
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (key) {
      if (section === 'inputs') {
        currentInput = { required: false };
        inputs[key[1]] = currentInput;
      } else {
        outputs.push(key[1]);
      }
      continue;
    }
    if (section === 'inputs' && currentInput) {
      const required = /^ {4}required:\s*(true|false)\s*$/u.exec(line);
      if (required) currentInput.required = required[1] === 'true';
      const dflt = /^ {4}default:\s*(.*?)\s*$/u.exec(line);
      if (dflt && dflt[1] !== '|' && dflt[1] !== '>-' && dflt[1] !== '>') {
        currentInput.default = dflt[1].replace(/^'(.*)'$/u, '$1');
      }
    }
  }
  return { inputs, outputs };
}

for (const [name, expected] of Object.entries(PUBLISHED)) {
  test(`published action surface: ${name}`, async () => {
    const file = path.join(actionsDirectory, name, 'action.yml');
    const source = await fs.readFile(file, 'utf8');
    const actual = parseActionSurface(source);

    assert.deepEqual(
      Object.keys(actual.inputs).sort(),
      Object.keys(expected.inputs).sort(),
      `${name}: input set changed`,
    );
    for (const [input, spec] of Object.entries(expected.inputs)) {
      assert.equal(
        actual.inputs[input].required,
        spec.required,
        `${name}.${input}: requiredness changed`,
      );
      if ('default' in spec) {
        assert.equal(
          actual.inputs[input].default ?? '',
          spec.default,
          `${name}.${input}: default changed`,
        );
      }
    }
    assert.deepEqual(
      actual.outputs.sort(),
      [...expected.outputs].sort(),
      `${name}: output set changed`,
    );
  });
}

// The generic parser skips block-scalar defaults, but
// snapshot-enforcement-scripts' default `actions` list IS published
// surface: a consumer that omits the input (sprinkles claude.yml) relies
// on it naming every post-agent gate. Assert the exact list so silently
// dropping a gate fails here.
test('snapshot-enforcement-scripts default gate list is guarded', async () => {
  const source = await fs.readFile(
    path.join(actionsDirectory, 'snapshot-enforcement-scripts', 'action.yml'),
    'utf8',
  );
  const lines = source.split(/\r?\n/gu);
  const start = lines.findIndex((line) => /^ {4}default: \|/u.test(line));
  assert.notEqual(start, -1, 'actions input must keep a block-scalar default');
  const entries = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const entry = /^ {6}([a-z-]+)\s*$/u.exec(lines[i]);
    if (!entry) break;
    entries.push(entry[1]);
  }
  // post-agent-gates is the orchestrator that now invokes the other three, so
  // it has to be snapshotted too: leave it out and an agent could rewrite
  // post-agent-gates.sh in the workspace and neutralize all three gates at
  // once, which is exactly what snapshotting into $RUNNER_TEMP prevents. It
  // was added to the action's default list when the orchestrator landed, but
  // this expectation was not updated -- and the mismatch went unnoticed
  // because an earlier CI step was aborting the job before this test ran.
  assert.deepEqual(entries, [
    'verify-deliverable',
    'report-failure',
    'telemetry-finalize',
    'post-agent-gates',
  ]);
});

// post-agent-gates has no action.yml -- see docs/published-actions.md's
// "Security: post-agent gates run from a pre-agent snapshot": it is
// deliberately never `uses:`-callable, only ever run from the pre-agent
// snapshot as `bash ".../post-agent-gates.sh"`, so a composite-action
// input/output surface would invite calling it post-agent and defeat the
// snapshot invariant. Its published surface is instead the environment-
// variable contract documented in its own header comment (#1208) -- parse
// that contract straight out of the script's own `: "${VAR:?...}"` (fails
// fast, required) and `VAR="${VAR:-...}"` (has a default, optional) shapes
// so silently adding, renaming, or dropping one fails here instead of only
// showing up as review-invisible drift in a consumer's hand-copied step.
test('post-agent-gates.sh env-var contract is guarded', async () => {
  const source = await fs.readFile(
    path.join(actionsDirectory, 'post-agent-gates', 'post-agent-gates.sh'),
    'utf8',
  );
  const required = [...source.matchAll(/^\s*: "\$\{([A-Z_]+):\?/gmu)].map(
    (m) => m[1],
  );
  const optional = [...source.matchAll(/^([A-Z_]+)="\$\{\1:-/gmu)].map(
    (m) => m[1],
  );

  assert.deepEqual(
    required.sort(),
    [
      // Always required.
      'GH_TOKEN',
      'AGENT',
      'REPO',
      'SERVER_URL',
      'RUN_ID',
      'JOB_STATUS',
      // Required only when JOB_STATUS is "success" (#815): the verify
      // phase is exact-marker-only. The legacy STARTED_AT +
      // EXPECTED_COMMENT_LOGIN inference pair (#1208 Phase 2/#1237's
      // ATTEMPT_ID optionality) was deleted once every fleet consumer
      // passed ATTEMPT_ID.
      'MODE',
      'ATTEMPT_ID',
    ].sort(),
    'post-agent-gates.sh: required env-var set changed',
  );
  assert.deepEqual(
    optional.sort(),
    [
      // Empty for a native (work-anchored) run -- forwarded unchanged to
      // telemetry-finalize.sh, which is already anchor-agnostic; the
      // verify-deliverable phase stays issue/PR-number-only for now (a
      // later task's job) (native work items, plan 3 task 3).
      'ISSUE',
      'WRITER_CREDENTIALS_FILE',
      'NO_DELIVERABLE_REASON',
      'FAILURE_LOG_SCAN_SCRIPT',
      // The orchestrator run id (`broker_intent_id`) -- forwarded
      // unchanged to telemetry-finalize.sh, then sidecar-lifecycle.sh
      // (task 7, native work items foundation).
      'INTENT_ID',
      // AGENT_STEP_OUTCOME, READINESS_FAILURE, and MAINTAINER were
      // retired 2026-08-17: the first two only fed the step's own
      // now-deleted $GITHUB_OUTPUT writes (nothing ever mapped
      // steps.post_agent_gates.outputs.* -- the hosted fallback finalizer
      // re-derives from job metadata by design), and MAINTAINER was
      // report-failure.sh's standalone direct-park toggle, retired with
      // that path.
    ].sort(),
    'post-agent-gates.sh: optional env-var set changed',
  );
});

test('every Published action directory exists', async () => {
  for (const name of Object.keys(PUBLISHED)) {
    await fs.access(path.join(actionsDirectory, name, 'action.yml'));
  }
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
