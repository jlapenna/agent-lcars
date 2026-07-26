import { execFile } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveGitRepo } from './git-repo';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const mockedExecFile = vi.mocked(execFile);
const cwd = '/workspace/project';

/** Drives `util.promisify(execFile)`'s error-first callback contract. */
function mockExecFileResult(stdout: string) {
  mockedExecFile.mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    callback(null, stdout, '');
  }) as unknown as typeof execFile);
}

function mockExecFileError(error: Error) {
  mockedExecFile.mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    callback(error, '', '');
  }) as unknown as typeof execFile);
}

describe('resolveGitRepo', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    'git@github.com:supersprinklesracing/sprinkles.git',
    'git@github.com:supersprinklesracing/sprinkles',
    'ssh://git@github.com/supersprinklesracing/sprinkles.git',
    'ssh://git@github.com/supersprinklesracing/sprinkles',
    'https://github.com/supersprinklesracing/sprinkles.git',
    'https://github.com/supersprinklesracing/sprinkles',
    'https://x-access-token@github.com/supersprinklesracing/sprinkles.git',
  ])('parses the GitHub origin URL %s', async (remoteUrl) => {
    mockExecFileResult(`${remoteUrl}\n`);

    await expect(resolveGitRepo(cwd)).resolves.toEqual({
      owner: 'supersprinklesracing',
      name: 'sprinkles',
    });
    expect(mockedExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', cwd, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' },
      expect.any(Function),
    );
  });

  it('normalizes a stale pre-rename origin (supersprinklesracing/members) to the current name', async () => {
    mockExecFileResult('git@github.com:supersprinklesracing/members.git\n');

    await expect(resolveGitRepo(cwd)).resolves.toEqual({
      owner: 'supersprinklesracing',
      name: 'sprinkles',
    });
  });

  it('returns undefined for a non-GitHub remote', async () => {
    mockExecFileResult('git@gitlab.com:supersprinklesracing/sprinkles.git\n');

    await expect(resolveGitRepo(cwd)).resolves.toBeUndefined();
  });

  it('fails soft when git cannot read origin', async () => {
    mockExecFileError(new Error('No such remote'));

    await expect(resolveGitRepo(cwd)).resolves.toBeUndefined();
  });
});
