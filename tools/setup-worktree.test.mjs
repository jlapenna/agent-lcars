import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('linked setup keeps submodule registration and deinitialization isolated from peers', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'lcars-worktree-dependency-'));
  try {
    const bin = join(temporary, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // Only the Git dependency behavior is under test. No package downloads,
    // user configuration, installed hooks or network repositories are used.
    const env = {
      PATH: bin + ':' + process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
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
    const upstream = join(temporary, 'upstream');
    mkdirSync(upstream);
    git(upstream, 'init', '-q', '--initial-branch=main');
    writeFileSync(join(upstream, 'source.txt'), 'upstream\n');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-qm', 'fixture');
    const revision = git(upstream, 'rev-parse', 'HEAD');

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
    writeFileSync(join(primary, 'tools', 'sync-package-skills.mjs'), '');
    const dependency = 'third_party/anthropic-plugins';
    const url = pathToFileURL(upstream).href;
    writeFileSync(
      join(primary, '.gitmodules'),
      `[submodule "${dependency}"]\n path = ${dependency}\n url = ${url}\n`,
    );
    git(primary, 'add', '.');
    git(
      primary,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${revision},${dependency}`,
    );
    git(primary, 'commit', '-qm', 'fixture');
    // A normal checkout creates an empty directory for an uninitialized gitlink.
    mkdirSync(join(primary, dependency), { recursive: true });

    // The dependency setup must continue to refuse the primary checkout.
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

    const peers = ['first', 'second'].map((name) => {
      const path = join(temporary, name);
      git(primary, 'worktree', 'add', '-q', '-b', name, path);
      command('/bin/bash', [join(path, 'tools/setup-worktree.sh')], path);
      assert.equal(
        git(
          path,
          'config',
          '--worktree',
          '--get',
          `submodule.${dependency}.url`,
        ),
        url,
      );
      assert.equal(
        git(
          path,
          'config',
          '--worktree',
          '--get',
          `submodule.${dependency}.active`,
        ),
        'true',
      );
      assert.equal(git(join(path, dependency), 'rev-parse', 'HEAD'), revision);
      return path;
    });
    command(
      'git',
      [
        'config',
        '--local',
        '--get-regexp',
        '^submodule[.]third_party/anthropic-plugins[.]',
      ],
      primary,
      1,
    );
    assert.equal(git(primary, 'status', '--porcelain'), '');
    const dirtyPeer = join(peers[1], dependency, 'source.txt');
    writeFileSync(dirtyPeer, 'private peer change\n');
    const before = git(peers[1], 'status', '--porcelain');
    assert.match(before, /third_party\/anthropic-plugins/);

    git(peers[0], 'submodule', 'deinit', '--', dependency);
    git(
      peers[0],
      'config',
      '--worktree',
      '--remove-section',
      `submodule.${dependency}`,
    );
    assert.equal(existsSync(join(peers[0], dependency, '.git')), false);
    assert.equal(git(peers[1], 'status', '--porcelain'), before);
    assert.equal(readFileSync(dirtyPeer, 'utf8'), 'private peer change\n');
    assert.equal(
      git(
        peers[1],
        'config',
        '--worktree',
        '--get',
        `submodule.${dependency}.url`,
      ),
      url,
    );
    assert.equal(
      git(
        peers[1],
        'config',
        '--worktree',
        '--get',
        `submodule.${dependency}.active`,
      ),
      'true',
    );
    assert.equal(
      git(join(peers[1], dependency), 'rev-parse', 'HEAD'),
      revision,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
