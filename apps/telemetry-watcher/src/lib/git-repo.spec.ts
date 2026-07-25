import { execFileSync } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveGitRepo } from './git-repo';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

const mockedExecFileSync = vi.mocked(execFileSync);
const cwd = '/workspace/project';

describe('resolveGitRepo', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    'git@github.com:supersprinklesracing/members.git',
    'git@github.com:supersprinklesracing/members',
    'ssh://git@github.com/supersprinklesracing/members.git',
    'ssh://git@github.com/supersprinklesracing/members',
    'https://github.com/supersprinklesracing/members.git',
    'https://github.com/supersprinklesracing/members',
    'https://x-access-token@github.com/supersprinklesracing/members.git',
  ])('parses the GitHub origin URL %s', (remoteUrl) => {
    mockedExecFileSync.mockReturnValue(`${remoteUrl}\n` as never);

    expect(resolveGitRepo(cwd)).toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', cwd, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  });

  it('returns undefined for a non-GitHub remote', () => {
    mockedExecFileSync.mockReturnValue(
      'git@gitlab.com:supersprinklesracing/members.git\n' as never,
    );

    expect(resolveGitRepo(cwd)).toBeUndefined();
  });

  it('fails soft when git cannot read origin', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('No such remote');
    });

    expect(resolveGitRepo(cwd)).toBeUndefined();
  });
});
