import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('linked setup refuses the primary checkout and scopes the agent identity to the worktree', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'lcars-worktree-setup-'));
  try {
    const bin = join(temporary, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'pnpm'),
      '#!/bin/sh\necho "$PWD" >> "$PNPM_LOG"\n',
      { mode: 0o700 },
    );
    const pnpmLog = join(temporary, 'pnpm.log');
    // Only setup's Git behavior is under test. No package downloads, user
    // configuration, installed hooks or network repositories are used.
    const env = {
      PATH: bin + ':' + process.env.PATH,
      HOME: process.env.HOME,
      PNPM_LOG: pnpmLog,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      CODEX_THREAD_ID: 'fixture',
    };
    const command = (binary, args, cwd, expected = 0) => {
      const result = spawnSync(binary, args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, result.stderr);
      return result.stdout.trim();
    };
    const git = (cwd, ...args) => command('git', args, cwd);

    const primary = join(temporary, 'primary');
    mkdirSync(join(primary, 'tools'), { recursive: true });
    git(primary, 'init', '-q', '--initial-branch=main');
    copyFileSync(
      new URL('./setup-worktree.sh', import.meta.url),
      join(primary, 'tools/setup-worktree.sh'),
    );
    for (const name of ['setup-nx-native-file-cache.sh', 'setup-git-hooks.sh'])
      writeFileSync(join(primary, 'tools', name), '#!/bin/sh\nexit 0\n', {
        mode: 0o700,
      });
    git(primary, 'add', '.');
    git(primary, 'commit', '-qm', 'fixture');

    command(
      '/bin/bash',
      [join(primary, 'tools/setup-worktree.sh')],
      primary,
      1,
    );
    command(
      'git',
      ['config', '--local', '--get', 'extensions.worktreeConfig'],
      primary,
      1,
    );

    const linked = join(temporary, 'linked');
    git(primary, 'worktree', 'add', '-q', '-b', 'linked', linked);
    command('/bin/bash', [join(linked, 'tools/setup-worktree.sh')], linked);
    command('/bin/bash', ['-c', `grep -qx '${linked}' '${pnpmLog}'`], linked);
    assert.equal(
      git(linked, 'config', '--worktree', '--get', 'user.name'),
      'agent-lcars-bot',
    );
    command('git', ['config', '--local', '--get', 'user.name'], primary, 1);
    assert.equal(git(primary, 'status', '--porcelain'), '');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
