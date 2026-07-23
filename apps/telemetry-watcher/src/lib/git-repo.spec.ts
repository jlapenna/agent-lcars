import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveGitRepo } from './git-repo';

describe('resolveGitRepo', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-test-'));
    execFileSync('git', ['init', '--initial-branch=main', repoDir]);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('resolves owner/name from an SSH remote URL', () => {
    execFileSync('git', [
      '-C',
      repoDir,
      'remote',
      'add',
      'origin',
      'git@github.com:supersprinklesracing/members.git',
    ]);

    expect(resolveGitRepo(repoDir)).toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
  });

  it('resolves owner/name from an SSH remote URL without a .git suffix', () => {
    execFileSync('git', [
      '-C',
      repoDir,
      'remote',
      'add',
      'origin',
      'git@github.com:supersprinklesracing/members',
    ]);

    expect(resolveGitRepo(repoDir)).toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
  });

  it('resolves owner/name from an HTTPS remote URL with a .git suffix', () => {
    execFileSync('git', [
      '-C',
      repoDir,
      'remote',
      'add',
      'origin',
      'https://github.com/supersprinklesracing/members.git',
    ]);

    expect(resolveGitRepo(repoDir)).toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
  });

  it('resolves owner/name from an HTTPS remote URL without a .git suffix', () => {
    execFileSync('git', [
      '-C',
      repoDir,
      'remote',
      'add',
      'origin',
      'https://github.com/supersprinklesracing/members',
    ]);

    expect(resolveGitRepo(repoDir)).toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
  });

  it('resolves owner/name from an HTTPS remote URL with a user@ prefix', () => {
    execFileSync('git', [
      '-C',
      repoDir,
      'remote',
      'add',
      'origin',
      'https://x-access-token@github.com/supersprinklesracing/members.git',
    ]);

    expect(resolveGitRepo(repoDir)).toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
  });

  it('fails soft for a non-git directory', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    try {
      expect(resolveGitRepo(nonGitDir)).toBeUndefined();
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('fails soft for a nonexistent directory', () => {
    expect(resolveGitRepo('/no/such/dir')).toBeUndefined();
  });

  it('fails soft when there is no origin remote', () => {
    expect(resolveGitRepo(repoDir)).toBeUndefined();
  });

  it('fails soft for a non-GitHub remote', () => {
    execFileSync('git', [
      '-C',
      repoDir,
      'remote',
      'add',
      'origin',
      'git@gitlab.com:supersprinklesracing/members.git',
    ]);

    expect(resolveGitRepo(repoDir)).toBeUndefined();
  });
});
