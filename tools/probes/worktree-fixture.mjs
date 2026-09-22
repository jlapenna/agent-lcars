import { execFileSync, spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Disposable local repository only: no remotes, user configuration, or tokens.
// The actual installed repo-tools guard must distinguish these two checkouts.
export function fileProbeFixture(directory, home, mode) {
  const primary = join(directory, 'primary');
  const feature = join(directory, 'workspace');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Probe',
    GIT_AUTHOR_EMAIL: 'probe@example.test',
    GIT_COMMITTER_NAME: 'Probe',
    GIT_COMMITTER_EMAIL: 'probe@example.test',
    GITHUB_ACTIONS: 'false',
  };
  for (const args of [
    ['init', '--initial-branch=main', primary],
    ['-C', primary, 'commit', '--allow-empty', '-m', 'Local probe fixture'],
    ['-C', primary, 'worktree', 'add', '-b', 'probe-feature', feature],
  ])
    execFileSync('git', args, { env, stdio: 'pipe', timeout: 10000 });
  const check = (cwd) =>
    spawnSync('repo-require-worktree', ['native file probe'], {
      cwd,
      env,
      timeout: 5000,
    });
  if (check(feature).status !== 0 || check(primary).status !== 1)
    throw new Error('Installed worktree guard failed its fixture control');
  const sentinel = join(
    mode.endsWith('-primary') || mode.endsWith('-symlink') ? primary : feature,
    'effect',
  );
  let target = sentinel;
  if (mode.endsWith('-symlink')) {
    writeFileSync(sentinel, 'original');
    target = join(feature, 'linked-effect');
    symlinkSync(sentinel, target);
  }
  return { sentinel, target };
}

export function expectedFileDenial(mode) {
  if (mode.endsWith('-review')) return 'This dispatch requests review';
  if (mode.endsWith('-ownership-unreadable'))
    return 'ownership could not be verified';
  if (mode.endsWith('-ownership-absent') || mode.endsWith('-ownership-changed'))
    return 'no longer claimed by the fleet';
  if (mode.endsWith('-primary') || mode.endsWith('-symlink'))
    return 'require a feature worktree';
  return '';
}
