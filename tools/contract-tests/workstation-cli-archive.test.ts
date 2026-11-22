import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The workstation `lcars` CLI reaches enrolled hosts as one published
// archive that homegit unpacks at ~/.local/share/agent-lcars-cli. These contracts
// cover the three owners of that path: the packager, the pre-publication
// check, and the workflow step that decides whether to publish.

const BIN = path.resolve('apps/telemetry-watcher/bin');
const PACKAGE = path.join(BIN, 'package-workstation-cli.sh');
const VERIFY = path.join(BIN, 'verify-workstation-cli.sh');
const INSTALL = path.join(BIN, 'install-session-title-cli.sh');
const ARCHIVE = 'lcars-workstation-cli.tar.gz';
const SOURCE = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workstation-cli-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], ...env },
  });
}

// Stand-ins for the real bundles. Each prints which bundle ran and the
// arguments it was given. Like the real one, the session-title bundle
// answers `session archive --help` by loading the flusher from beside itself.
const HOOK = 'telemetry-watcher-hook/lcars-hook.cjs';
const FLUSH = 'telemetry-watcher-hook-flush/lcars-hook-flush.cjs';
const TITLE = 'telemetry-watcher-session-title-cli/lcars-session-title.cjs';
const print = (usage: string) =>
  `console.log(${JSON.stringify(usage)}, JSON.stringify(process.argv.slice(2)));\n`;
const BUNDLES: Record<string, string> = {
  [HOOK]: print('usage: lcars hook claude'),
  [FLUSH]: "console.log('usage: lcars session archive');\n",
  [TITLE]: `if (process.argv.slice(2).join(' ') === 'session archive --help')
  require(require('node:path').join(__dirname, 'lcars-hook-flush.cjs'));
else ${print('usage: session title')}`,
};

function dist(root: string, overrides: Record<string, string> = {}): string {
  const dir = path.join(root, 'dist');
  for (const [file, source] of Object.entries(BUNDLES)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), overrides[file] ?? source);
  }
  return dir;
}

function pack(root: string, revision = SOURCE, name = 'out', from?: string) {
  const out = path.join(root, name);
  const result = run(PACKAGE, [out, revision, from ?? dist(root)]);
  return { out, result, archive: path.join(out, ARCHIVE) };
}

function unpack(root: string, archive: string): string {
  const lib = path.join(root, 'home/.local/share/agent-lcars-cli');
  mkdirSync(lib, { recursive: true });
  expect(run('tar', ['-xzf', archive, '-C', lib]).status).toBe(0);
  return lib;
}

describe('package-workstation-cli.sh', () => {
  it('packs the launcher, the three bundles, their checksums and the revision', () => {
    const root = tempRoot();
    const { out, result, archive } = pack(root);
    expect(result.status, result.stderr).toBe(0);

    const listing = run('tar', ['-tzf', archive]).stdout.trim().split('\n');
    expect(listing.sort()).toEqual([
      'REVISION',
      'SHA256SUMS',
      'lcars',
      'lcars-hook-flush.cjs',
      'lcars-hook.cjs',
      'lcars-session-title.cjs',
    ]);

    const lib = unpack(root, archive);
    expect(readFileSync(path.join(lib, 'REVISION'), 'utf8')).toBe(
      `${SOURCE}\n`,
    );
    expect(statSync(path.join(lib, 'lcars')).mode & 0o777).toBe(0o755);
    // The published checksum list is the one inside the archive.
    expect(readFileSync(path.join(out, 'SHA256SUMS'), 'utf8')).toBe(
      readFileSync(path.join(lib, 'SHA256SUMS'), 'utf8'),
    );
    expect(
      spawnSync('sha256sum', ['--check', '--quiet', 'SHA256SUMS'], {
        cwd: lib,
      }).status,
    ).toBe(0);
  });

  it('packs the same content to the same bytes', () => {
    const root = tempRoot();
    const from = dist(root);
    const first = pack(root, SOURCE, 'first', from);
    const second = pack(root, SOURCE, 'second', from);
    expect(readFileSync(first.archive)).toEqual(readFileSync(second.archive));
  });

  it('keeps the checksum list unchanged when only the revision moves', () => {
    const root = tempRoot();
    const from = dist(root);
    const first = pack(root, SOURCE, 'first', from);
    const second = pack(root, NEWER, 'second', from);
    // This is what lets the publisher skip a commit that did not touch the CLI.
    expect(readFileSync(path.join(second.out, 'SHA256SUMS'), 'utf8')).toBe(
      readFileSync(path.join(first.out, 'SHA256SUMS'), 'utf8'),
    );
    expect(readFileSync(second.archive)).not.toEqual(
      readFileSync(first.archive),
    );
  });

  it('writes a launcher that runs the bundles from the installed directory', () => {
    const root = tempRoot();
    const lib = unpack(root, pack(root).archive);
    const env = { HOME: path.join(root, 'home') };

    // From anywhere, and through a link, as ~/.local/bin/lcars is installed.
    const link = path.join(root, 'lcars');
    symlinkSync(path.join(lib, 'lcars'), link);

    expect(run(link, ['hook', 'claude', 'Stop'], env).stdout).toBe(
      'usage: lcars hook claude ["hook","claude","Stop"]\n',
    );
    expect(run(link, ['session', 'title', 'a b'], env).stdout).toBe(
      'usage: session title ["session","title","a b"]\n',
    );
  });

  it('refuses a revision that is not a commit, and a missing bundle', () => {
    const root = tempRoot();
    const short = pack(root, 'abc123');
    expect(short.result.status).toBe(2);
    expect(existsSync(short.archive)).toBe(false);

    const from = dist(root);
    rmSync(path.join(from, HOOK));
    const missing = pack(root, SOURCE, 'missing', from);
    expect(missing.result.status).toBe(1);
    expect(missing.result.stderr).toContain('lcars-hook.cjs is missing');
    expect(existsSync(missing.archive)).toBe(false);
  });
});

describe('verify-workstation-cli.sh', () => {
  it('accepts an archive whose launcher reaches both bundles', () => {
    const root = tempRoot();
    const result = run(VERIFY, [pack(root).archive]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`at ${SOURCE}`);
  });

  it('rejects a hook bundle that does not answer, although it exits 0', () => {
    const root = tempRoot();
    const from = dist(root, { [HOOK]: 'process.exit(0);\n' });
    const result = run(VERIFY, [pack(root, SOURCE, 'out', from).archive]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not reach the hook bundle');
  });

  it.each([
    ['does not parse', 'const = ;\n'],
    ['cannot load a dependency', "require('lcars-not-bundled');\n"],
  ])('rejects a flusher that %s', (_name, source) => {
    const root = tempRoot();
    const from = dist(root, { [FLUSH]: source });
    const result = run(VERIFY, [pack(root, SOURCE, 'out', from).archive]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('flusher bundle did not load');
  });

  it('rejects an archive carrying anything else', () => {
    const root = tempRoot();
    const lib = unpack(root, pack(root).archive);
    writeFileSync(path.join(lib, 'extra.cjs'), '');
    const tampered = path.join(root, 'tampered.tar.gz');
    expect(run('tar', ['-czf', tampered, '-C', lib, '.']).status).toBe(0);
    const result = run(VERIFY, [tampered]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('extra.cjs');
  });
});

describe('install-session-title-cli.sh', () => {
  // Homegit manages the published copy; a development install written over
  // it would surface as a conflict at homegit's next apply.
  it.each(['published revision', 'linked launcher'])(
    'refuses to write over the published copy (%s)',
    (kind) => {
      const root = tempRoot();
      const lib = path.join(root, 'lib');
      const bin = path.join(root, 'bin');
      mkdirSync(lib);
      mkdirSync(bin);
      if (kind === 'published revision')
        writeFileSync(path.join(lib, 'REVISION'), `${SOURCE}\n`);
      else symlinkSync(path.join(lib, 'lcars'), path.join(bin, 'lcars'));

      const result = run(INSTALL, [], {
        AGENT_LCARS_SESSION_TITLE_CLI_LIB_DIR: lib,
        AGENT_LCARS_SESSION_TITLE_CLI_BIN_DIR: bin,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('homegit manages');
      expect(existsSync(path.join(lib, 'lcars-hook.cjs'))).toBe(false);
    },
  );
});

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  steps: Step[];
}
const workflow = parse(
  readFileSync('.github/workflows/publish-workstation-cli.yml', 'utf8'),
) as {
  permissions: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, Job>;
};

describe('publish-workstation-cli.yml', () => {
  const FAKE_GH = path.resolve(
    'tools/contract-tests/fixtures/fake-gh-release.cjs',
  );
  const { build, publish: publishJob } = workflow.jobs;

  it('gives write access only to a job that runs no checkout code', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(build?.permissions).toBeUndefined();
    expect(publishJob?.permissions).toEqual({ contents: 'write' });
    expect(
      publishJob?.steps.some((step) =>
        step.uses?.startsWith('actions/checkout'),
      ),
    ).toBe(false);
    const checkout = build?.steps.find((step) =>
      step.uses?.startsWith('actions/checkout'),
    );
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  it('admits only a push run of main, or a dispatch on main, to the gate', () => {
    const admitted = workflow.jobs['gate']?.if?.replace(/\s+/g, ' ') ?? '';
    expect(admitted).toContain(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    );
    for (const clause of [
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
    ])
      expect(admitted).toContain(clause);
    // The run's rollup conclusion is not the gate: a non-required job that
    // times out reports the run cancelled although Verify passed.
    expect(admitted).not.toContain('workflow_run.conclusion');
    expect(workflow.jobs['gate']?.permissions).toEqual({ actions: 'read' });
    expect(build?.needs).toBe('gate');
    expect(build?.if).toBe("needs.gate.outputs.verify_passed == 'true'");
    expect(publishJob?.needs).toBe('build');
    expect(publishJob?.if).toBeUndefined();
  });

  const gateScript = workflow.jobs['gate']?.steps.find(
    (step) => step.name === "Read Verify's conclusion",
  )?.run as string;

  // Runs the gate's own step against the fake `gh`.
  function gate(
    event: 'workflow_run' | 'workflow_dispatch',
    state: {
      jobs?: { name: string; conclusion: string | null }[];
      fail?: string[];
    } = {},
  ) {
    const root = tempRoot();
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(FAKE_GH, path.join(bin, 'gh'));
    const statePath = path.join(root, 'state.json');
    const output = path.join(root, 'output');
    writeFileSync(statePath, JSON.stringify({ release: null, ...state }));
    writeFileSync(path.join(root, 'gh.log'), '');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', gateScript], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env['PATH']}`,
        GITHUB_REPOSITORY: 'jlapenna/agent-lcars',
        GITHUB_OUTPUT: output,
        EVENT_NAME: event,
        RUN_ID: '7',
        HEAD_SHA: SOURCE,
        FAKE_GH_STATE: statePath,
        FAKE_GH_LOG: path.join(root, 'gh.log'),
      },
    });
    return { result, output: readFileSync(output, 'utf8').trim() };
  }

  it('publishes when Verify passed although another job cancelled the run', () => {
    const { result, output } = gate('workflow_run', {
      jobs: [
        { name: 'E2E', conclusion: 'cancelled' },
        { name: 'Verify', conclusion: 'success' },
      ],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe('verify_passed=true');
  });

  it.each([
    ['failed', [{ name: 'Verify', conclusion: 'failure' }]],
    ['has not finished', [{ name: 'Verify', conclusion: null }]],
    ['did not run', [{ name: 'E2E', conclusion: 'success' }]],
  ])('publishes nothing, without failing, when Verify %s', (_name, jobs) => {
    const { result, output } = gate('workflow_run', { jobs });
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe('verify_passed=false');
    expect(result.stdout).toContain('nothing to publish');
  });

  it('fails, publishing nothing, when the jobs cannot be read', () => {
    const { result, output } = gate('workflow_run', { fail: ['jobs'] });
    expect(result.status).not.toBe(0);
    expect(output).toBe('');
  });

  it('lets a manual dispatch through without a CI run to ask about', () => {
    const { result, output } = gate('workflow_dispatch', { fail: ['jobs'] });
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe('verify_passed=true');
  });

  it('serializes publications on the publish job, not the workflow', () => {
    // Every CI completion starts a run of this workflow. A workflow-level
    // group would let a pull request's run replace a pending main one
    // before the build job's `if` turned it away.
    expect(workflow.concurrency).toBeUndefined();
    expect(build?.concurrency).toBeUndefined();
    expect(publishJob?.concurrency).toEqual({
      group: 'publish-workstation-cli',
      'cancel-in-progress': false,
    });
  });

  it('hands the archive over from a directory upload-artifact does not skip', () => {
    const upload = build?.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact'),
    );
    const download = publishJob?.steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact'),
    );
    const uploaded = String(upload?.with?.['path']);
    // upload-artifact leaves hidden paths out, the search root included.
    expect(uploaded.split('/').some((part) => part.startsWith('.'))).toBe(
      false,
    );
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.['name']).toBe(download?.with?.['name']);
    expect(
      build?.steps.some((step) =>
        step.run?.includes(uploaded.replace(/\/$/, '')),
      ),
    ).toBe(true);
  });

  const script = publishJob?.steps.find(
    (step) => step.name === 'Publish when the CLI changed',
  )?.run as string;
  const ASSET = { id: 1, name: ARCHIVE };
  const SUMS = { id: 2, name: 'SHA256SUMS' };
  const notes = (revision: string) =>
    `Workstation CLI.\n\nSource revision: ${revision}\n`;

  interface Release {
    body: string;
    draft: boolean;
    assets: { id: number; name: string }[];
  }
  interface GhState {
    release: Release | null;
    sums?: string;
    compare?: string;
    fail?: string[];
  }

  // Runs the workflow's own step against the fake `gh`, which keeps a
  // release, changes it as GitHub would and records every call.
  function publisher(initial: GhState) {
    const root = tempRoot();
    const bin = path.join(root, 'bin');
    const work = path.join(root, 'work');
    for (const dir of [bin, work]) mkdirSync(dir);
    symlinkSync(FAKE_GH, path.join(bin, 'gh'));
    // The step waits between rename attempts; the test does not need to.
    writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(bin, 'sleep'), 0o755);
    writeFileSync(path.join(work, ARCHIVE), 'archive');
    writeFileSync(path.join(work, 'SHA256SUMS'), 'new sums\n');
    const statePath = path.join(root, 'state.json');
    const log = path.join(root, 'gh.log');
    writeFileSync(statePath, JSON.stringify({ nextId: 10, ...initial }));
    writeFileSync(log, '');
    let attempt = 0;
    return {
      set(change: Partial<GhState>) {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        writeFileSync(statePath, JSON.stringify({ ...state, ...change }));
      },
      run() {
        const temp = path.join(root, `runner-temp-${attempt++}`);
        mkdirSync(temp);
        writeFileSync(log, '');
        const result = spawnSync('bash', ['-c', script], {
          cwd: work,
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env['PATH']}`,
            GH_REPO: 'jlapenna/agent-lcars',
            SOURCE_SHA: SOURCE,
            TAG: 'workstation-cli',
            RUNNER_TEMP: temp,
            FAKE_GH_STATE: statePath,
            FAKE_GH_LOG: log,
          },
        });
        const calls = readFileSync(log, 'utf8').trim().split('\n');
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as GhState;
        return {
          result,
          calls,
          // Everything that changed the release, in order.
          changes: calls
            .filter(
              (call) =>
                /^release (create|upload|edit) /.test(call) ||
                /^api --method (DELETE|PATCH) /.test(call),
            )
            .map((call) => call.replace(/ \S*runner-temp-\d+\//, ' ')),
          release: state.release,
          sums: state.sums,
          names: state.release?.assets.map((asset) => asset.name).sort(),
        };
      },
    };
  }
  const published = (body: string, sums = 'old sums\n'): GhState => ({
    release: { body, draft: false, assets: [ASSET, SUMS] },
    sums,
  });

  it('creates the release empty at the built revision, then fills it', () => {
    const { result, changes, release, names, sums } = publisher({
      release: null,
    }).run();
    expect(result.status, result.stderr).toBe(0);
    // No files on create: with them the release would start as a draft.
    expect(changes[0]).toMatch(
      new RegExp(
        `^release create workstation-cli --target ${SOURCE} --latest=false --title Workstation CLI --notes .*Source revision: ${SOURCE} *$`,
      ),
    );
    expect(release?.draft).toBe(false);
    expect(names).toEqual(['SHA256SUMS', ARCHIVE]);
    expect(sums).toBe('new sums\n');
  });

  it('changes nothing when the published CLI already matches', () => {
    const { result, changes } = publisher(
      published(notes(NEWER), 'new sums\n'),
    ).run();
    expect(result.status, result.stderr).toBe(0);
    expect(changes).toEqual([]);
  });

  it('swaps the archive in under its name without first removing it', () => {
    const { result, changes, release, names, sums } = publisher({
      ...published(notes(NEWER)),
      compare: 'behind',
    }).run();
    expect(result.status, result.stderr).toBe(0);
    expect(
      changes.map((call) => call.split(' ').slice(0, 5).join(' ')),
    ).toEqual([
      'release edit workstation-cli --draft=false --notes',
      `release upload workstation-cli ${ARCHIVE}.new --clobber`,
      'api --method DELETE repos/jlapenna/agent-lcars/releases/assets/1 --silent',
      `api --method PATCH repos/jlapenna/agent-lcars/releases/assets/10 -f`,
      'release upload workstation-cli SHA256SUMS --clobber',
    ]);
    expect(changes[3]).toContain(`name=${ARCHIVE}`);
    expect(release?.body).toContain(`Source revision: ${SOURCE}`);
    expect(names).toEqual(['SHA256SUMS', ARCHIVE]);
    expect(sums).toBe('new sums\n');
  });

  it('leaves a newer build in place when an older commit arrives late', () => {
    const { result, changes, calls } = publisher({
      ...published(notes(NEWER)),
      compare: 'ahead',
    }).run();
    expect(result.status, result.stderr).toBe(0);
    expect(changes).toEqual([]);
    // Base is this run's commit: "ahead" then means the published one is
    // its descendant.
    expect(calls).toContain(
      `api repos/jlapenna/agent-lcars/compare/${SOURCE}...${NEWER} --jq .status`,
    );
  });

  it('fails without publishing when the commits cannot be compared', () => {
    const { result, changes } = publisher({
      ...published(notes(NEWER)),
      fail: ['compare'],
    }).run();
    expect(result.status).not.toBe(0);
    expect(changes).toEqual([]);
  });

  it('fails without publishing when the release cannot be read', () => {
    const { result, changes } = publisher({
      ...published(notes(NEWER)),
      fail: ['read'],
    }).run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Could not read release');
    expect(changes).toEqual([]);
  });

  it('keeps the live archive when the new upload fails, and finishes on the next run', () => {
    const run = publisher({
      ...published(notes(NEWER)),
      compare: 'behind',
      fail: [`upload:${ARCHIVE}.new`],
    });
    const failed = run.run();
    expect(failed.result.status).not.toBe(0);
    // What workstations fetch is untouched, and so is what the next run
    // compares against.
    expect(failed.release?.assets).toContainEqual(ASSET);
    expect(failed.sums).toBe('old sums\n');

    run.set({ fail: [] });
    const retried = run.run();
    expect(retried.result.status, retried.result.stderr).toBe(0);
    expect(retried.names).toEqual(['SHA256SUMS', ARCHIVE]);
    expect(retried.sums).toBe('new sums\n');
  });

  it('retries the rename, and the next run finishes one that never succeeded', () => {
    const run = publisher({
      ...published(notes(NEWER)),
      compare: 'behind',
      fail: ['rename'],
    });
    const failed = run.run();
    expect(failed.result.status).not.toBe(0);
    expect(
      failed.changes.filter((call) => call.startsWith('api --method PATCH ')),
    ).toHaveLength(3);
    // The checksum list is still the old one, so the next run does not
    // mistake this for published.
    expect(failed.sums).toBe('old sums\n');
    expect(failed.names).toEqual(['SHA256SUMS', `${ARCHIVE}.new`]);

    run.set({ fail: [] });
    const retried = run.run();
    expect(retried.result.status, retried.result.stderr).toBe(0);
    expect(retried.names).toEqual(['SHA256SUMS', ARCHIVE]);
    expect(retried.sums).toBe('new sums\n');
  });

  it('publishes again when the archive is missing although the checksums match', () => {
    const { result, names } = publisher({
      release: { body: notes(SOURCE), draft: false, assets: [SUMS] },
      sums: 'new sums\n',
    }).run();
    expect(result.status, result.stderr).toBe(0);
    expect(names).toEqual(['SHA256SUMS', ARCHIVE]);
  });
});
