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
// commit `sha-<repo>`, raw contents from <dir>/repos/<owner>/<repo>/, and
// visibility (private when that directory holds a `.private` file).
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
  repos/*/*)
    if [ "\${3:-}" = .private ]; then
      [ -d "${dir}/repos/\${1#repos/}" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
      [ -f "${dir}/repos/\${1#repos/}/.private" ] && echo true || echo false
      exit
    fi
    echo main; exit ;;
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

const lockfile =
  "lockfileVersion: '9.0'\n\npackages:\n  left@1.0.0:\n    resolution: {integrity: sha512-left}\n";
const patchedLockfile =
  "lockfileVersion: '9.0'\n\npatchedDependencies:\n  left@1.0.0:\n    hash: abc\n    path: patches/left.patch\n\npackages:\n  left@1.0.0:\n    resolution: {integrity: sha512-left}\n";

describe('runner pnpm seed sync', () => {
  it('leaves authenticated packages to jobs while retaining all public content', () => {
    const source = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      public: {specifier: 1.0.0, version: 1.0.0(@club/design@1.0.0)}
      '@club/design': {specifier: 1.0.0, version: 1.0.0}
    devDependencies:
      alias: {specifier: 'npm:@club/design@1.0.0', version: '@club/design@1.0.0'}
packages:
  public@1.0.0: {resolution: {integrity: sha512-public}}
  child@2.0.0: {resolution: {integrity: sha512-child}}
  '@club/design@1.0.0':
    resolution: {tarball: 'https://npm.pkg.github.com/download/@club/design/1.0.0/abc', integrity: sha512-private}
snapshots:
  public@1.0.0(@club/design@1.0.0):
    dependencies: {'@club/design': 1.0.0}
    optionalDependencies: {alias: '@club/design@1.0.0', child: 2.0.0}
  '@club/design@1.0.0': {dependencies: {child: 2.0.0}}
  child@2.0.0: {}
`;
    const f = fixture({
      'acme/app': {
        'package.json': '{"packageManager":"pnpm@11.28.2"}',
        'pnpm-lock.yaml': source,
        '.npmrc': '//npm.pkg.github.com/:_authToken=must-not-copy',
      },
    });
    f.run(['acme/app']);
    const result = parse(f.read('fleet/acme__app/pnpm-lock.yaml'));
    expect(result.packages).toEqual({
      'public@1.0.0': { resolution: { integrity: 'sha512-public' } },
      'child@2.0.0': { resolution: { integrity: 'sha512-child' } },
    });
    expect(result.importers['.']).toEqual({
      dependencies: {
        public: { specifier: '1.0.0', version: '1.0.0(@club/design@1.0.0)' },
      },
      devDependencies: {},
    });
    expect(result.snapshots).toEqual({
      'public@1.0.0(@club/design@1.0.0)': {
        dependencies: {},
        optionalDependencies: { child: '2.0.0' },
      },
      'child@2.0.0': {},
    });
    expect(existsSync(path.join(f.seed, 'fleet/acme__app/.npmrc'))).toBe(false);
  });

  it('leaves packages from private GitHub repositories to jobs', () => {
    const source = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@club/design': {specifier: 'github:club/design#v1', version: 'git+https://github.com/club/design.git#aaa'}
      '@club/hidden': {specifier: 'github:club/hidden#v1', version: 'git+https://github.com/club/hidden.git#bbb'}
      '@acme/tools': {specifier: 'github:acme/tools#v1', version: 'https://codeload.github.com/acme/tools/tar.gz/ccc'}
      '@acme/lib': {specifier: 'github:acme/lib#v1', version: 'git+https://github.com/acme/lib.git#ddd'}
packages:
  '@club/design@git+https://github.com/club/design.git#aaa':
    resolution: {commit: aaa, repo: https://github.com/club/design.git, type: git}
  '@club/hidden@git+https://github.com/club/hidden.git#bbb':
    resolution: {commit: bbb, repo: https://git@github.com/club/hidden.git, type: git}
  '@acme/tools@https://codeload.github.com/acme/tools/tar.gz/ccc':
    resolution: {gitHosted: true, integrity: sha512-tools, tarball: https://codeload.github.com/acme/tools/tar.gz/ccc}
  '@acme/lib@git+https://github.com/acme/lib.git#ddd':
    resolution: {commit: ddd, repo: https://git@github.com/acme/lib.git, type: git}
snapshots:
  '@club/design@git+https://github.com/club/design.git#aaa': {}
  '@club/hidden@git+https://github.com/club/hidden.git#bbb': {}
  '@acme/tools@https://codeload.github.com/acme/tools/tar.gz/ccc': {}
  '@acme/lib@git+https://github.com/acme/lib.git#ddd': {}
`;
    const f = fixture({
      'acme/app': {
        'package.json': '{"packageManager":"pnpm@11.28.2"}',
        'pnpm-lock.yaml': source,
      },
      // club/hidden is absent: a repository the token cannot see is private.
      'club/design': { '.private': '' },
      'acme/tools': { 'README.md': '' },
      'acme/lib': { 'README.md': '' },
    });
    f.run(['acme/app']);
    const result = parse(f.read('fleet/acme__app/pnpm-lock.yaml'));
    expect(Object.keys(result.packages)).toEqual([
      '@acme/tools@https://codeload.github.com/acme/tools/tar.gz/ccc',
      '@acme/lib@git+https://github.com/acme/lib.git#ddd',
    ]);
    expect(Object.keys(result.importers['.'].dependencies)).toEqual([
      '@acme/tools',
      '@acme/lib',
    ]);
    expect(Object.keys(result.snapshots)).toEqual(Object.keys(result.packages));
  });

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

  it('normalizes patch identities and nested peers while retaining package content', () => {
    const hash = 'a'.repeat(64);
    const source = `lockfileVersion: '9.0'
patchedDependencies:
  left@1.0.0:
    hash: ${hash}
    path: patches/left.patch
importers:
  .:
    dependencies:
      left:
        specifier: 1.0.0
        version: 1.0.0(patch_hash=${hash})(peer@2.0.0)
packages:
  left@1.0.0:
    resolution: {integrity: sha512-original}
snapshots:
  left@1.0.0(patch_hash=${hash})(peer@2.0.0):
    dependencies:
      nested: 3.0.0(left@1.0.0(patch_hash=${hash})(peer@2.0.0))
`;
    const f = fixture({
      'acme/app': {
        'package.json': '{"packageManager":"pnpm@11.28.2"}',
        'pnpm-lock.yaml': source,
      },
    });
    f.run(['acme/app']);
    const result = parse(f.read('fleet/acme__app/pnpm-lock.yaml'));
    expect(result.patchedDependencies).toBeUndefined();
    expect(result.packages).toEqual(parse(source).packages);
    expect(result.importers['.'].dependencies.left).toEqual({
      specifier: '1.0.0',
      version: '1.0.0(peer@2.0.0)',
    });
    expect(result.snapshots['left@1.0.0(peer@2.0.0)'].dependencies.nested).toBe(
      '3.0.0(left@1.0.0(peer@2.0.0))',
    );
  });

  it('refuses conflicting identities instead of dropping a dependency graph', () => {
    const hash = 'b'.repeat(64);
    const f = fixture({
      'acme/app': {
        'package.json': '{"packageManager":"pnpm@11.28.2"}',
        'pnpm-lock.yaml': `lockfileVersion: '9.0'
packages:
  left@1.0.0: {resolution: {integrity: sha512-left}}
snapshots:
  left@1.0.0: {dependencies: {peer: 1.0.0}}
  left@1.0.0(patch_hash=${hash}): {dependencies: {peer: 2.0.0}}
`,
      },
    });
    expect(() => f.run(['acme/app'])).toThrow(
      /contradictory normalized seed dependency identity/,
    );
  });

  it('validates the project document of a multi-document lockfile', () => {
    const configDocument =
      "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    configDependencies: {}\n";
    const f = fixture({
      'acme/app': {
        'package.json': '{"packageManager":"pnpm@11.28.2"}',
        'pnpm-lock.yaml': `---\n${configDocument}\n---\n${lockfile}`,
      },
    });
    expect(f.run(['acme/app'])).toBe('acme/app sha-acme-app\n');
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
      'a pnpm 10 package manager',
      {
        'package.json': '{"packageManager":"pnpm@10.18.0"}',
        'pnpm-lock.yaml': lockfile,
      },
      /the image seeds only the pnpm 11/,
    ],
    [
      'a missing lockfile',
      { 'package.json': '{"packageManager":"pnpm@11.27.1"}' },
      /has no pnpm-lock.yaml/,
    ],
    // #2084: Renovate rewrote every seed lockfile to one locking nothing.
    [
      'an empty lockfile',
      {
        'package.json': '{"packageManager":"pnpm@11.27.1"}',
        'pnpm-lock.yaml': '',
      },
      /seed lockfile is empty/,
    ],
    [
      'a lockfile that locks no packages',
      {
        'package.json': '{"packageManager":"pnpm@11.27.1"}',
        'pnpm-lock.yaml':
          "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n\npackages: {}\n",
      },
      /seed lockfile locks no packages/,
    ],
    [
      'a pre-pnpm-11 lockfile',
      {
        'package.json': '{"packageManager":"pnpm@11.27.1"}',
        'pnpm-lock.yaml':
          "lockfileVersion: '6.0'\n\npackages:\n  /left@1.0.0: {}\n",
      },
      /lockfileVersion '6.0'/,
    ],
  ])('fails on %s', (_name, files, error) => {
    const f = fixture({ 'acme/app': files });
    expect(() => f.run(['acme/app'])).toThrow(error);
    // Nothing is written, so the refresh workflow has nothing to commit.
    expect(existsSync(path.join(f.seed, 'fleet/acme__app'))).toBe(false);
  });
});
