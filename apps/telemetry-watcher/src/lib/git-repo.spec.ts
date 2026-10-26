import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execFile } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isInsideGitCheckout, resolveGitRepo } from './git-repo';

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

  it('writes a watched repository under its canonical spelling for a mixed-case remote', async () => {
    mockExecFileResult('git@github.com:JLapenna/Agent-LCARS.git\n');

    await expect(
      resolveGitRepo(cwd, ['supersprinklesracing/*', 'jlapenna/agent-lcars']),
    ).resolves.toEqual({ owner: 'jlapenna', name: 'agent-lcars' });
    await expect(resolveGitRepo(cwd, ['jlapenna/*'])).resolves.toEqual({
      owner: 'jlapenna',
      name: 'agent-lcars',
    });
  });

  it('keeps the remote spelling for an unwatched repository', async () => {
    mockExecFileResult('git@github.com:SomeOne/Private-Repo.git\n');

    await expect(resolveGitRepo(cwd, ['jlapenna/*'])).resolves.toEqual({
      owner: 'SomeOne',
      name: 'Private-Repo',
    });
    await expect(resolveGitRepo(cwd)).resolves.toEqual({
      owner: 'SomeOne',
      name: 'Private-Repo',
    });
  });

  it('lets a rename alias win over allowlist canonicalization, matching case-insensitively', async () => {
    process.env['AGENT_TELEMETRY_REPO_ALIASES'] = JSON.stringify({
      'supersprinklesracing/members': {
        owner: 'SuperSprinklesRacing',
        name: 'Sprinkles',
      },
    });
    mockExecFileResult('git@github.com:SuperSprinklesRacing/Members.git\n');

    await expect(
      resolveGitRepo(cwd, ['supersprinklesracing/*']),
    ).resolves.toEqual({ owner: 'SuperSprinklesRacing', name: 'Sprinkles' });
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

describe('isInsideGitCheckout', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  function tree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-git-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'p/repo/.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'p/repo/src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'p/worktree/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'p/worktree/.git'), 'gitdir: x\n');
    fs.mkdirSync(path.join(root, 'p/notes'), { recursive: true });
    return root;
  }

  it.each([
    ['p/repo', true],
    ['p/repo/src', true],
    ['p/worktree/src', true],
    ['p/notes', false],
    ['p', false],
  ])('%s → %s', (dir, expected) => {
    expect(isInsideGitCheckout(path.join(tree(), dir))).toBe(expected);
  });
});
