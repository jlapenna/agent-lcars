import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CLI_TRANSCRIPT_MAX_BYTES } from '@agent-lcars/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CliArchiveDependencies,
  cliArchiveRetentionReady,
  executeCliArchiveCommand,
  readCliArchive,
} from './cli-archive-command';

const directories: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-archive-'));
  directories.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({
      timestamp: '2026-10-25T00:00:00Z',
      type: 'session_meta',
      payload: { id: 'session-1', cwd: '/work', source: 'cli' },
    }) + '\n',
  );
  const deps: CliArchiveDependencies = {
    env: { CODEX_THREAD_ID: 'session-1' },
    host: 'host',
    repos: ['owner/repo'],
    bucket: 'archives',
    now: () => new Date('2026-10-25T00:00:00Z'),
    id: () => 'capture-1',
    getSession: vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      source: 'cli',
      agent: 'codex',
      host: 'host',
      repo: { owner: 'owner', name: 'repo' },
    }),
    claim: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(true),
    revoke: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { file, deps };
}
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('explicit CLI snapshot consent', () => {
  it('archives a consented Claude Code snapshot through its existing adapter', async () => {
    const { file, deps } = fixture();
    deps.env = { CLAUDE_CODE_SESSION_ID: 'session-1' };
    vi.mocked(deps.getSession).mockResolvedValue({
      sessionId: 'session-1',
      source: 'cli',
      agent: 'claude-code',
      host: 'host',
      repo: { owner: 'owner', name: 'repo' },
    });
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        timestamp: '2026-10-25T00:00:00Z',
        message: { role: 'user', content: 'Investigate this session.' },
      }) + '\n',
    );
    expect(
      await executeCliArchiveCommand(['--consent', file], deps),
    ).toMatchObject({ ok: true });
    expect(deps.upload).toHaveBeenCalledWith(
      'cli-consented-v1/claude-code/session-1/capture-1.jsonl',
      expect.any(Buffer),
    );
  });
  it('requires deployed deletion for both live and noncurrent snapshots', () => {
    const rule = {
      action: { type: 'Delete' },
      condition: { age: 7, matchesPrefix: ['cli-consented-v1/'] },
    };
    expect(cliArchiveRetentionReady({ lifecycle: { rule: [rule] } })).toBe(
      true,
    );
    expect(
      cliArchiveRetentionReady({
        lifecycle: {
          rule: [{ ...rule, condition: { ...rule.condition, isLive: false } }],
        },
      }),
    ).toBe(false);
    expect(
      cliArchiveRetentionReady({
        lifecycle: {
          rule: [{ ...rule, condition: { ...rule.condition, age: 90 } }],
        },
      }),
    ).toBe(false);
    expect(cliArchiveRetentionReady({})).toBe(false);
  });
  it('publishes a bounded snapshot for the current allowed session after upload', async () => {
    const { file, deps } = fixture();
    expect(
      await executeCliArchiveCommand(['--consent', file], deps),
    ).toMatchObject({ ok: true });
    expect(deps.upload).toHaveBeenCalledWith(
      'cli-consented-v1/codex/session-1/capture-1.jsonl',
      expect.any(Buffer),
    );
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      'capture-1',
      'gs://archives/cli-consented-v1/codex/session-1/capture-1.jsonl',
      '2026-11-01T00:00:00.000Z',
    );
    expect(vi.mocked(deps.publish).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(deps.upload).mock.invocationCallOrder[0],
    );
  });
  it.each([
    'missing-consent',
    'excluded',
    'runner',
    'wrong-host',
    'wrong-session',
    'mixed-session',
  ])('refuses %s without uploading', async (scenario) => {
    const { file, deps } = fixture();
    if (scenario === 'excluded') deps.repos = [];
    if (scenario === 'runner') deps.env['LCARS_RUN_ID'] = 'run-1';
    if (scenario === 'wrong-host') deps.host = 'other';
    if (scenario === 'wrong-session') deps.env['CODEX_THREAD_ID'] = 'other';
    if (scenario === 'mixed-session')
      fs.appendFileSync(
        file,
        JSON.stringify({ type: 'session_meta', payload: { id: 'other' } }) +
          '\n',
      );
    const args = scenario === 'missing-consent' ? [file] : ['--consent', file];
    expect(await executeCliArchiveCommand(args, deps)).toMatchObject({
      ok: false,
    });
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });
  it('refuses oversized files and symlinks before reading them', () => {
    const { file } = fixture();
    fs.truncateSync(file, CLI_TRANSCRIPT_MAX_BYTES + 1);
    expect(() => readCliArchive(file)).toThrow();
    fs.symlinkSync(file, `${file}.link`);
    expect(() => readCliArchive(`${file}.link`)).toThrow();
  });
  it('does not publish a failed upload and records its failure', async () => {
    const { file, deps } = fixture();
    vi.mocked(deps.upload).mockRejectedValue(
      new Error('private provider error'),
    );
    const result = await executeCliArchiveCommand(['--consent', file], deps);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('private');
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(expect.anything(), 'capture-1');
  });
  it('removes an upload whose consent was revoked before publication', async () => {
    const { file, deps } = fixture();
    vi.mocked(deps.publish).mockResolvedValue(false);
    expect(
      await executeCliArchiveCommand(['--consent', file], deps),
    ).toMatchObject({ ok: false });
    expect(deps.remove).toHaveBeenCalledWith(
      'cli-consented-v1/codex/session-1/capture-1.jsonl',
    );
  });
  it('invalidates access before deleting the owned object on revocation', async () => {
    const { deps } = fixture();
    // Withdrawal must still work after the repository is removed from consent scope.
    deps.repos = [];
    vi.mocked(deps.revoke).mockResolvedValue(
      'gs://archives/cli-consented-v1/codex/session-1/capture-1.jsonl',
    );
    expect(await executeCliArchiveCommand(['--revoke'], deps)).toMatchObject({
      ok: true,
    });
    expect(deps.remove).toHaveBeenCalledWith(
      'cli-consented-v1/codex/session-1/capture-1.jsonl',
    );
    expect(vi.mocked(deps.remove).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(deps.revoke).mock.invocationCallOrder[0],
    );
  });
});
