// Guards the published-action surface documented in
// docs/published-actions.md: every Published-tier action's inputs (name,
// requiredness, default) and outputs are asserted against the manifest
// below. A failing run means the surface changed - removing/renaming an
// input or output, flipping optional->required, or changing a default is
// a breaking change for any consumer repo that resolves these actions
// cross-repo (all track `@main`), and must be a deliberate edit to this
// manifest, called out in review. Removing a deprecated surface outright
// is fine once nothing references it - see docs/published-actions.md.
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
  // The fleet's one OIDC-mint-then-POST transport (#1340 A-R3/D7):
  // consumers are sprinkles' pr-heal/visual-refresh/
  // post-deploy-verify and this repo's own dispatch-reconcile. Exactly one
  // of payload/payloads may be set; `payloads` (newline-delimited compact
  // JSON, one POST per line under a single minted token) is the
  // mint-once-reuse batch shape post-deploy-verify's per-issue loop needs,
  // and both empty means a bodyless POST (the reconcile endpoint's shape).
  'oidc-post': {
    inputs: {
      endpoint: { required: true },
      audience: { required: true },
      payload: { required: false, default: '' },
      payloads: { required: false, default: '' },
      'timeout-seconds': { required: false, default: '60' },
    },
    outputs: ['response'],
  },
  // Shared notice/summary surface for an engaged CI control flag
  // (docs/ci-control-flags.md). Consumed cross-repo by sprinkles'
  // e2e.yml (two jobs), in addition to this repo's own ci.yml.
  'control-flag': {
    inputs: {
      name: { required: true },
      lane: { required: true },
      'restore-command': { required: true },
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
