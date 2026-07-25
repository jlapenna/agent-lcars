import { execFileSync } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveGitBranch } from './git-branch';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

const mockedExecFileSync = vi.mocked(execFileSync);

describe('resolveGitBranch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the branch reported by git', () => {
    mockedExecFileSync.mockReturnValue('feature/foo\n' as never);

    expect(resolveGitBranch('/workspace/project')).toBe('feature/foo');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/workspace/project', 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  });

  it('returns undefined for a detached HEAD', () => {
    mockedExecFileSync.mockReturnValue('HEAD\n' as never);

    expect(resolveGitBranch('/workspace/project')).toBeUndefined();
  });

  it('fails soft when git fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    expect(resolveGitBranch('/workspace/project')).toBeUndefined();
  });
});
