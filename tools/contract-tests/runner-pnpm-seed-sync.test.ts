import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = process.cwd();
const script = path.join(root, 'tools/sync-runner-pnpm-seed.py');
const dirs: string[] = [];

// A fake `gh api` serving fixture repositories: default branch `main`, head
// commit `sha-<repo>`, and raw contents from <dir>/repos/<owner>/<repo>/.
function fixture(repositories: Record<string, Record<string, string>>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-seed-sync-'));
  dirs.push(dir);
  for (const [repository, files] of Object.entries(repositories)) {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(dir, 'repos', repository, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(
    path.join(dir, 'bin/gh'),
    `#!/usr/bin/env bash
set -eu
shift # api
[ "$1" = -H ] && shift 2
echo "$1 token=\${GH_TOKEN:-}" >> "${dir}/calls"
case "$1" in
  repos/*/*/commits/main) r="\${1#repos/}"; echo "sha-\${r%/commits/main}" | tr / -; exit ;;
  repos/*/*/contents/*)
    rest="\${1#repos/}"; repository="\${rest%%/contents/*}"; file="\${rest#*/contents/}"; file="\${file%%\\?ref=*}"
    [ -f "${dir}/repos/$repository/$file" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    cat "${dir}/repos/$repository/$file"; exit ;;
  repos/*/*) echo main; exit ;;
esac
exit 2
`,
    { mode: 0o755 },
  );
  const seed = path.join(dir, 'seed');
  mkdirSync(seed);
  const run = (fleet: string[], env: Record<string, string> = {}) => {
    writeFileSync(
      path.join(seed, 'fleet.json'),
      JSON.stringify({ repositories: fleet }),
    );
    return execFileSync('python3', [script, '--seed-dir', seed], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}/bin:${process.env.PATH}`,
        GH_TOKEN: 'default-token',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const read = (file: string) => readFileSync(path.join(seed, file), 'utf8');
  return { dir, seed, run, read };
}

afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

const lockfile = "lockfileVersion: '9.0'\n\npackages: {}\n";
const patchedLockfile =
  "lockfileVersion: '9.0'\n\npatchedDependencies:\n  left@1.0.0:\n    hash: abc\n    path: patches/left.patch\n\npackages: {}\n";

describe('runner pnpm seed sync', () => {
  it('copies only what pnpm fetch needs from each repository', () => {
    const f = fixture({
      'acme/app': {
        'package.json': JSON.stringify({
          name: 'app',
          packageManager: 'pnpm@11.27.1',
          scripts: { postinstall: 'curl evil' },
          dependencies: { left: '1.0.0' },
        }),
        'pnpm-lock.yaml': patchedLockfile,
        'pnpm-workspace.yaml':
          'packages: [apps/*]\noverrides: {a: "1"}\nsupportedArchitectures:\n  cpu: [x64, arm64]\npatchedDependencies:\n  left@1.0.0: patches/left.patch\n',
        'patches/left.patch': 'diff --git a/x b/x\n',
      },
    });

    expect(f.run(['acme/app'])).toBe('acme/app sha-acme-app\n');

    expect(JSON.parse(f.read('fleet/acme__app/package.json'))).toEqual({
      name: 'runner-pnpm-seed-acme-app',
      private: true,
      packageManager: 'pnpm@11.27.1',
    });
    // The patch map is dropped and no patch file is copied: the store holds
    // unpatched content, so pnpm fetch needs neither.
    expect(f.read('fleet/acme__app/pnpm-lock.yaml')).toBe(lockfile);
    expect(parse(f.read('fleet/acme__app/pnpm-workspace.yaml'))).toEqual({
      supportedArchitectures: { cpu: ['x64', 'arm64'] },
    });
    expect(existsSync(path.join(f.seed, 'fleet/acme__app/patches'))).toBe(
      false,
    );
  });

  it('removes repositories that left the fleet and uses per-owner tokens', () => {
    const repository = {
      'package.json': JSON.stringify({ packageManager: 'pnpm@11.27.0' }),
      'pnpm-lock.yaml': lockfile,
    };
    const f = fixture({ 'acme/app': repository, 'other-org/site': repository });
    f.run(['acme/app', 'other-org/site'], {
      GH_TOKEN_OTHER_ORG: 'other-token',
    });
    expect(existsSync(path.join(f.seed, 'fleet/other-org__site'))).toBe(true);
    expect(
      existsSync(path.join(f.seed, 'fleet/acme__app/pnpm-workspace.yaml')),
    ).toBe(false);
    const calls = readFileSync(path.join(f.dir, 'calls'), 'utf8');
    expect(calls).toContain('repos/other-org/site token=other-token');
    expect(calls).toContain('repos/acme/app token=default-token');

    f.run(['acme/app']);
    expect(existsSync(path.join(f.seed, 'fleet/other-org__site'))).toBe(false);
  });

  it.each([
    [
      'a non-pnpm package manager',
      { 'package.json': '{"packageManager":"npm@12.0.2"}' },
      /does not declare a pnpm packageManager/,
    ],
    [
      'a missing lockfile',
      { 'package.json': '{"packageManager":"pnpm@11.27.1"}' },
      /has no pnpm-lock.yaml/,
    ],
  ])('fails on %s', (_name, files, error) => {
    const f = fixture({ 'acme/app': files });
    expect(() => f.run(['acme/app'])).toThrow(error);
  });
});
