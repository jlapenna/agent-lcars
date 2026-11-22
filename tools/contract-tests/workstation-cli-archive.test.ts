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

// Stand-ins for the real bundles: each prints which bundle ran, the
// arguments it was given, and the usage line the pre-publication check reads.
const BUNDLES = {
  'telemetry-watcher-hook/lcars-hook.cjs': 'usage: lcars hook claude',
  'telemetry-watcher-hook-flush/lcars-hook-flush.cjs': 'flush',
  'telemetry-watcher-session-title-cli/lcars-session-title.cjs':
    'usage: session title',
} as const;

function dist(root: string, overrides: Record<string, string> = {}): string {
  const dir = path.join(root, 'dist');
  for (const [file, usage] of Object.entries(BUNDLES)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(
      path.join(dir, file),
      overrides[file] ??
        `console.log(${JSON.stringify(usage)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
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
    rmSync(path.join(from, 'telemetry-watcher-hook/lcars-hook.cjs'));
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
    const from = dist(root, {
      'telemetry-watcher-hook/lcars-hook.cjs': 'process.exit(0);\n',
    });
    const result = run(VERIFY, [pack(root, SOURCE, 'out', from).archive]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not reach the hook bundle');
  });

  it('rejects a flusher that does not parse', () => {
    const root = tempRoot();
    const from = dist(root, {
      'telemetry-watcher-hook-flush/lcars-hook-flush.cjs': 'const = ;\n',
    });
    const result = run(VERIFY, [pack(root, SOURCE, 'out', from).archive]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('flusher bundle does not parse');
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
  permissions?: Record<string, string>;
  steps: Step[];
}
const workflow = parse(
  readFileSync('.github/workflows/publish-workstation-cli.yml', 'utf8'),
) as { permissions: Record<string, string>; jobs: Record<string, Job> };

describe('publish-workstation-cli.yml', () => {
  it('gives write access only to a job that runs no checkout code', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const { build, publish } = workflow.jobs;
    expect(build?.permissions).toBeUndefined();
    expect(publish?.permissions).toEqual({ contents: 'write' });
    expect(
      publish?.steps.some((step) => step.uses?.startsWith('actions/checkout')),
    ).toBe(false);
    const checkout = build?.steps.find((step) =>
      step.uses?.startsWith('actions/checkout'),
    );
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  const script = workflow.jobs['publish']?.steps.find(
    (step) => step.name === 'Publish when the CLI changed',
  )?.run as string;

  // Runs the workflow's own step against a fake `gh` that answers from files
  // and records every call, so the decision is the workflow's.
  function publish(state: {
    tags?: string;
    publishedSums?: string;
    body?: string;
    compare?: string;
    listFails?: boolean;
  }) {
    const root = tempRoot();
    const bin = path.join(root, 'bin');
    const gh = path.join(root, 'gh-state');
    const work = path.join(root, 'work');
    const temp = path.join(root, 'runner-temp');
    for (const dir of [bin, gh, work, temp]) mkdirSync(dir);
    writeFileSync(path.join(work, ARCHIVE), 'archive');
    writeFileSync(path.join(work, 'SHA256SUMS'), 'new sums\n');
    writeFileSync(path.join(gh, 'tags'), state.tags ?? '');
    if (state.publishedSums !== undefined)
      writeFileSync(path.join(gh, 'SHA256SUMS'), state.publishedSums);
    writeFileSync(path.join(gh, 'body'), state.body ?? '');
    writeFileSync(path.join(gh, 'compare'), state.compare ?? '');
    if (state.listFails) writeFileSync(path.join(gh, 'list-fails'), '');
    const log = path.join(root, 'gh.log');
    writeFileSync(log, '');
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh
# One line per call: release notes span several.
printf '%s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> "${log}"
case "$1 $2" in
  'release list') [ -e "${gh}/list-fails" ] && exit 1; cat "${gh}/tags" ;;
  'release download')
    while [ "$#" -gt 1 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    [ -e "${gh}/SHA256SUMS" ] || exit 1
    cp "${gh}/SHA256SUMS" "$dir/SHA256SUMS" ;;
  'release view') cat "${gh}/body" ;;
  api\\ *) cat "${gh}/compare" ;;
esac
`,
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    const result = spawnSync('bash', ['-c', script], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env['PATH']}`,
        GH_REPO: 'jlapenna/agent-lcars',
        SOURCE_SHA: SOURCE,
        TAG: 'workstation-cli',
        RUNNER_TEMP: temp,
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const changes = calls.filter((call) =>
      /^release (create|upload|edit) /.test(call),
    );
    return { result, changes };
  }

  it('creates the release, at the built revision, the first time', () => {
    const { result, changes } = publish({ tags: 'some-other-tag\n' });
    expect(result.status, result.stderr).toBe(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(
      new RegExp(`^release create workstation-cli --target ${SOURCE} `),
    );
    expect(changes[0]).toContain(`Source revision: ${SOURCE}`);
    expect(changes[0]).toMatch(/lcars-workstation-cli\.tar\.gz SHA256SUMS$/);
  });

  it('changes nothing when the published CLI already matches', () => {
    const { result, changes } = publish({
      tags: 'workstation-cli\n',
      publishedSums: 'new sums\n',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(changes).toEqual([]);
  });

  it('replaces the archive before its checksum list, then the notes', () => {
    const { result, changes } = publish({
      tags: 'workstation-cli\n',
      publishedSums: 'old sums\n',
      body: `Notes\n\nSource revision: ${NEWER}\n`,
      compare: 'behind\n',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      changes.map((call) => call.split(' ').slice(0, 4).join(' ')),
    ).toEqual([
      'release upload workstation-cli lcars-workstation-cli.tar.gz',
      'release upload workstation-cli SHA256SUMS',
      'release edit workstation-cli --notes',
    ]);
    expect(changes[2]).toContain(`Source revision: ${SOURCE}`);
  });

  it('leaves a newer build in place when an older commit arrives late', () => {
    const { result, changes } = publish({
      tags: 'workstation-cli\n',
      publishedSums: 'old sums\n',
      body: `Notes\n\nSource revision: ${NEWER}\n`,
      compare: 'ahead\n',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(changes).toEqual([]);
  });

  it('publishes when the release has lost its checksum list', () => {
    const { result, changes } = publish({
      tags: 'workstation-cli\n',
      body: `Notes\n\nSource revision: ${SOURCE}\n`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(changes).toHaveLength(3);
  });

  it('fails without publishing when the releases cannot be read', () => {
    const { result, changes } = publish({ listFails: true });
    expect(result.status).not.toBe(0);
    expect(changes).toEqual([]);
  });
});
