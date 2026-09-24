// Build-time installation/verification of the public package's own CLI bins.
// pnpm install creates dependency shims, not shims for the root package.
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const [mode, source, destination] = process.argv.slice(2);
if (!['install', 'verify'].includes(mode) || !source || !destination)
  throw new Error(
    'Usage: repo-tools-bins.mjs <install|verify> <package> <bin>',
  );
const root = realpathSync(source);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!manifest.bin?.['repo-require-worktree'])
  throw new Error('repo-tools package does not declare the worktree guard');
for (const [name, target] of Object.entries(manifest.bin)) {
  if (!/^repo-[a-z0-9-]+$/.test(name) || typeof target !== 'string')
    throw new Error('Invalid repo-tools bin declaration');
  const executable = realpathSync(resolve(root, target));
  const local = relative(root, executable);
  if (local === '..' || local.startsWith('../') || isAbsolute(local))
    throw new Error(`Package bin escapes its source: ${name}`);
  accessSync(executable, constants.X_OK);
  const installed = join(destination, name);
  if (mode === 'install') symlinkSync(executable, installed);
  if (realpathSync(installed) !== executable)
    throw new Error(`Installed package bin does not match: ${name}`);
  accessSync(installed, constants.X_OK);
}

if (mode === 'verify') {
  const fixture = mkdtempSync(join(tmpdir(), 'repo-tools-image-check-'));
  try {
    const primary = join(fixture, 'primary');
    const feature = join(fixture, 'feature');
    const env = {
      PATH: process.env.PATH,
      HOME: fixture,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Image setup check',
      GIT_AUTHOR_EMAIL: 'setup@example.test',
      GIT_COMMITTER_NAME: 'Image setup check',
      GIT_COMMITTER_EMAIL: 'setup@example.test',
      GITHUB_ACTIONS: 'false',
    };
    const run = (binary, args, cwd, expected = 0) => {
      const result = spawnSync(binary, args, {
        cwd,
        env,
        timeout: 10000,
        encoding: 'utf8',
      });
      if (result.error || result.status !== expected)
        throw new Error(
          `Image setup command failed: ${binary} (${result.status})`,
        );
    };
    run('git', ['init', '--initial-branch=main', primary], fixture);
    run('git', ['commit', '--allow-empty', '-m', 'Setup fixture'], primary);
    run('git', ['worktree', 'add', '-b', 'setup-feature', feature], primary);
    const guard = join(destination, 'repo-require-worktree');
    run(guard, ['image setup check'], feature);
    run(guard, ['image setup check'], primary, 1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
console.log(`repo-tools package binaries: ${mode} passed`);
