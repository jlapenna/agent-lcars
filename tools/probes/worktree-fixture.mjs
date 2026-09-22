import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
  if (mode.includes('-session-'))
    return 'Native session identity does not match';
  if (mode.endsWith('-review')) return 'This dispatch requests review';
  if (mode.endsWith('-ownership-unreadable'))
    return 'ownership could not be verified';
  if (mode.endsWith('-ownership-absent') || mode.endsWith('-ownership-changed'))
    return 'no longer claimed by the fleet';
  if (mode.endsWith('-primary') || mode.endsWith('-symlink'))
    return 'require a feature worktree';
  return '';
}

// Native Git pushes publish only to a disposable local bare repository.
// Read its actual refs, not a stubbed Git command or the provider's prose.
export function gitPushFixture(directory, home, mode) {
  fileProbeFixture(directory, home, mode);
  const remote = join(directory, 'remote.git');
  const source = join(
    directory,
    mode.endsWith('-primary') ? 'primary' : 'workspace',
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  execFileSync('git', ['init', '--bare', remote], {
    env,
    stdio: 'pipe',
    timeout: 10000,
  });
  const expected = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  const preserved = join(source, 'unpublished-work.txt');
  writeFileSync(preserved, 'retain unpublished work\n');
  const sentinel = join(remote, 'refs', 'heads', 'first');
  const secondSentinel = join(remote, 'refs', 'heads', 'second');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    sentinel,
    secondSentinel,
    command: (second) =>
      `git -C ${quote(source)} push ${quote(remote)} HEAD:refs/heads/${second ? 'second' : 'first'}`,
    verify: () => {
      const allowed =
        mode.endsWith('-allow') || mode.endsWith('-ownership-changed');
      return (
        existsSync(sentinel) === allowed &&
        (!allowed || readFileSync(sentinel, 'utf8') === expected) &&
        !existsSync(secondSentinel) &&
        readFileSync(preserved, 'utf8') === 'retain unpublished work\n'
      );
    },
  };
}
