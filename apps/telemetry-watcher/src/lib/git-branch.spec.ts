import { execFile } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveGitBranch } from './git-branch';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const mockedExecFile = vi.mocked(execFile);

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

describe('resolveGitBranch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the branch reported by git', async () => {
    mockExecFileResult('feature/foo\n');

    await expect(resolveGitBranch('/workspace/project')).resolves.toBe(
      'feature/foo',
    );
    expect(mockedExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/workspace/project', 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8' },
      expect.any(Function),
    );
  });

  it('returns undefined for a detached HEAD', async () => {
    mockExecFileResult('HEAD\n');

    await expect(
      resolveGitBranch('/workspace/project'),
    ).resolves.toBeUndefined();
  });

  it('fails soft when git fails', async () => {
    mockExecFileError(new Error('not a git repository'));

    await expect(
      resolveGitBranch('/workspace/project'),
    ).resolves.toBeUndefined();
  });
});
