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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
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
  'setup-repo-checks': {
    inputs: {
      tool: { required: true },
      'tool-source': { required: false, default: 'install' },
      'actionlint-version': { required: false, default: '1.7.7' },
    },
    outputs: [],
  },
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
      // Permission inputs remain optional individually; the composite requires
      // at least one explicit permission before delegating the native mint.
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
  // post-deploy-verify. Exactly one
  // of payload/payloads may be set; `payloads` (newline-delimited compact
  // JSON, one POST per line under a single minted token) is the
  // mint-once-reuse batch shape post-deploy-verify's per-issue loop needs,
  // and both empty means a bodyless POST.
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

// Exercise the public shell entry point with installers forbidden. This runs
// in the existing published-interface merge gate, without network access.
test('setup-repo-checks baked tools validate exact versions without installation', async () => {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), 'baked-repo-checks-'),
  );
  const bin = path.join(scratch, 'bin');
  await fs.mkdir(bin);
  const write = async (name, body) =>
    fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try {
    for (const name of [
      'curl',
      'python3',
      'pip',
      'apt-get',
      'sudo',
      'mktemp',
    ]) {
      await write(name, 'echo forbidden-installer >&2; exit 97');
    }
    for (const name of ['uname', 'head', 'awk', 'sed', 'dirname']) {
      await fs.symlink(`/usr/bin/${name}`, path.join(bin, name));
    }
    const versions = {
      gitleaks: '8.18.2',
      actionlint: 'v1.7.7',
      shellcheck: 'version: 0.10.0',
      pyflakes: '3.2.0 Python 3.12.0 on Linux',
    };
    const invoke = (tool, extra = {}) =>
      spawnSync(
        '/bin/bash',
        [path.join(actionsDirectory, 'setup-repo-checks/install.sh')],
        {
          encoding: 'utf8',
          env: { PATH: bin, CHECK_TOOL: tool, TOOL_SOURCE: 'baked', ...extra },
        },
      );
    for (const [name, version] of Object.entries(versions))
      await write(name, `echo '${version}'`);
    for (const tool of ['gitleaks', 'actionlint']) {
      const result = invoke(tool);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const name of Object.keys(versions)) {
      const tool = name === 'gitleaks' ? name : 'actionlint';
      await write(name, 'echo wrong');
      let result = invoke(tool);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /version mismatch/);
      assert.doesNotMatch(result.stderr, /forbidden-installer/);
      await fs.unlink(path.join(bin, name));
      result = invoke(tool);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /is missing/);
      assert.doesNotMatch(result.stderr, /forbidden-installer/);
      await write(name, `echo '${versions[name]}'`);
    }
    let result = invoke('actionlint', { ACTIONLINT_VERSION: '1.7.8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected 1.7.8/);
    await write('actionlint', "echo 'v1.7.8'");
    assert.equal(
      invoke('actionlint', { ACTIONLINT_VERSION: '1.7.8' }).status,
      0,
    );
    result = invoke('gitleaks', { TOOL_SOURCE: 'automatic' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tool-source must be baked or install/);
    assert.doesNotMatch(result.stderr, /forbidden-installer/);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('setup-repo-checks default install verifies and extracts the selected release on x64 and arm64', async () => {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), 'install-repo-checks-'),
  );
  const bin = path.join(scratch, 'bin');
  const assets = path.join(scratch, 'assets');
  await fs.mkdir(bin);
  await fs.mkdir(assets);
  const write = async (name, body) =>
    fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try {
    await fs.writeFile(
      path.join(assets, 'gitleaks'),
      '#!/bin/sh\necho 8.18.2\n',
      { mode: 0o755 },
    );
    for (const [_machine, arch] of [
      ['x86_64', 'x64'],
      ['aarch64', 'arm64'],
    ]) {
      const asset = `gitleaks_8.18.2_linux_${arch}.tar.gz`;
      assert.equal(
        spawnSync('tar', [
          '-czf',
          path.join(assets, asset),
          '-C',
          assets,
          'gitleaks',
        ]).status,
        0,
      );
    }
    const checksums = spawnSync(
      '/bin/sh',
      ['-c', 'sha256sum gitleaks_*.tar.gz'],
      { cwd: assets, encoding: 'utf8' },
    );
    assert.equal(checksums.status, 0);
    await fs.writeFile(
      path.join(assets, 'gitleaks_8.18.2_checksums.txt'),
      checksums.stdout,
    );
    await write(
      'uname',
      'if [ "$1" = -s ]; then echo Linux; else echo "$MACHINE"; fi',
    );
    await write(
      'curl',
      `for argument do case "$argument" in https://*) url="$argument";; esac; done
case "$url" in https://github.com/gitleaks/gitleaks/releases/download/v8.18.2/*) ;; *) exit 96;; esac
while [ "$1" != -o ]; do shift; done
cp "$ASSETS/$(basename "$url")" "$2"`,
    );
    for (const mode of [undefined, 'install']) {
      for (const machine of ['x86_64', 'aarch64']) {
        const githubPath = path.join(scratch, 'github-path');
        await fs.writeFile(githubPath, '');
        const env = {
          PATH: `${bin}:/usr/bin:/bin`,
          CHECK_TOOL: 'gitleaks',
          RUNNER_TEMP: scratch,
          GITHUB_PATH: githubPath,
          MACHINE: machine,
          ASSETS: assets,
        };
        if (mode) env.TOOL_SOURCE = mode;
        const result = spawnSync(
          '/bin/bash',
          [path.join(actionsDirectory, 'setup-repo-checks/install.sh')],
          { env, encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /OK/);
        const installedBin = (await fs.readFile(githubPath, 'utf8')).trim();
        assert.equal(
          spawnSync(path.join(installedBin, 'gitleaks'), ['version'], {
            encoding: 'utf8',
          }).stdout.trim(),
          '8.18.2',
        );
      }
    }
    // A tampered release must be rejected by the real sha256sum before extraction.
    await fs.appendFile(
      path.join(assets, 'gitleaks_8.18.2_linux_x64.tar.gz'),
      'tampered',
    );
    const result = spawnSync(
      '/bin/bash',
      [path.join(actionsDirectory, 'setup-repo-checks/install.sh')],
      {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          CHECK_TOOL: 'gitleaks',
          RUNNER_TEMP: scratch,
          GITHUB_PATH: path.join(scratch, 'rejected-path'),
          MACHINE: 'x86_64',
          ASSETS: assets,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FAILED/);
    await assert.rejects(fs.access(path.join(scratch, 'rejected-path')));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
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
