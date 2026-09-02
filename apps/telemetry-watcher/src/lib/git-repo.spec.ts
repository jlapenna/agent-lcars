import { execFile } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const originalRepoAliases = process.env['AGENT_TELEMETRY_REPO_ALIASES'];

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env['AGENT_TELEMETRY_REPO_ALIASES'];
  });

  afterEach(() => {
    if (originalRepoAliases === undefined) {
      delete process.env['AGENT_TELEMETRY_REPO_ALIASES'];
    } else {
      process.env['AGENT_TELEMETRY_REPO_ALIASES'] = originalRepoAliases;
    }
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

  it('normalizes a stale pre-rename origin per AGENT_TELEMETRY_REPO_ALIASES', async () => {
    process.env['AGENT_TELEMETRY_REPO_ALIASES'] = JSON.stringify({
      'supersprinklesracing/members': {
        owner: 'supersprinklesracing',
        name: 'sprinkles',
      },
    });
    mockExecFileResult('git@github.com:supersprinklesracing/members.git\n');

    await expect(resolveGitRepo(cwd)).resolves.toEqual({
      owner: 'supersprinklesracing',
      name: 'sprinkles',
    });
  });

  it('leaves a pre-rename origin unchanged with no configured alias (default)', async () => {
    mockExecFileResult('git@github.com:supersprinklesracing/members.git\n');

    await expect(resolveGitRepo(cwd)).resolves.toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
  });

  it('throws on malformed AGENT_TELEMETRY_REPO_ALIASES JSON', async () => {
    process.env['AGENT_TELEMETRY_REPO_ALIASES'] = 'not json';
    mockExecFileResult('git@github.com:supersprinklesracing/sprinkles.git\n');

    await expect(resolveGitRepo(cwd)).rejects.toThrow(
      /AGENT_TELEMETRY_REPO_ALIASES is not valid JSON/,
    );
  });

  it('throws on an AGENT_TELEMETRY_REPO_ALIASES entry missing owner/name', async () => {
    process.env['AGENT_TELEMETRY_REPO_ALIASES'] = JSON.stringify({
      'supersprinklesracing/members': { owner: 'supersprinklesracing' },
    });
    mockExecFileResult('git@github.com:supersprinklesracing/members.git\n');

    await expect(resolveGitRepo(cwd)).rejects.toThrow(
      /must be an object with string "owner" and "name" fields/,
    );
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
