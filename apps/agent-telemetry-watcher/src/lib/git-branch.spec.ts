import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveGitBranch } from './git-branch';

describe('resolveGitBranch', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-test-'));
    execFileSync('git', ['init', '--initial-branch=main', repoDir]);
    execFileSync('git', [
      '-C',
      repoDir,
      'config',
      'user.email',
      'test@test.com',
    ]);
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello');
    execFileSync('git', ['-C', repoDir, 'add', 'file.txt']);
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('resolves the current branch of a git dir', () => {
    expect(resolveGitBranch(repoDir)).toBe('main');
  });

  it('resolves a branch after checking out a new one', () => {
    execFileSync('git', ['-C', repoDir, 'checkout', '-b', 'feature/foo']);
    expect(resolveGitBranch(repoDir)).toBe('feature/foo');
  });

  it('fails soft for a non-git directory', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    try {
      expect(resolveGitBranch(nonGitDir)).toBeUndefined();
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('fails soft for a nonexistent directory', () => {
    expect(resolveGitBranch('/no/such/dir')).toBeUndefined();
  });
});
