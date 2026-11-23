import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CliArchiveDependencies,
  cliArchiveRetentionReady,
  createBoundedFdReadStream,
  executeCliArchiveCommand,
  openCliArchiveFd,
} from './cli-archive-command';

async function readStreamToBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

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
  const uploaded: { object?: string; bytes?: Buffer; byteLength?: number } = {};
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
    upload: vi.fn(async (object, source, byteLength) => {
      uploaded.object = object;
      uploaded.byteLength = byteLength;
      uploaded.bytes = await readStreamToBuffer(source);
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { file, deps, uploaded };
}
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('explicit CLI snapshot consent', () => {
  it('archives a consented Claude Code snapshot through its existing adapter', async () => {
    const { file, deps, uploaded } = fixture();
    deps.env = { CLAUDE_CODE_SESSION_ID: 'session-1' };
    vi.mocked(deps.getSession).mockResolvedValue({
      sessionId: 'session-1',
      source: 'cli',
      agent: 'claude-code',
      host: 'host',
      repo: { owner: 'owner', name: 'repo' },
    });
    const content =
      JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        timestamp: '2026-10-25T00:00:00Z',
        message: { role: 'user', content: 'Investigate this session.' },
      }) + '\n';
    fs.writeFileSync(file, content);
    expect(
      await executeCliArchiveCommand(['--consent', file], deps),
    ).toMatchObject({ ok: true });
    expect(uploaded.object).toBe(
      'cli-consented-v1/claude-code/session-1/capture-1.jsonl',
    );
    expect(uploaded.byteLength).toBe(Buffer.byteLength(content, 'utf8'));
    expect(uploaded.bytes?.toString('utf8')).toBe(content);
  });

  it('streams a >5 MiB CLI transcript snapshot without dropping it as too-large', async () => {
    const { file, deps, uploaded } = fixture();
    const header =
      JSON.stringify({
        timestamp: '2026-10-25T00:00:00Z',
        type: 'session_meta',
        payload: { id: 'session-1', cwd: '/work', source: 'cli' },
      }) + '\n';
    const turnLine =
      JSON.stringify({
        timestamp: '2026-10-25T00:01:00Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'x'.repeat(64 * 1024) },
      }) + '\n';
    const stream = fs.openSync(file, 'w');
    try {
      fs.writeSync(stream, header);
      // 96 * ~64 KiB > 6 MiB total, well past the retired 5 MiB cap.
      for (let i = 0; i < 96; i += 1) {
        fs.writeSync(stream, turnLine);
      }
    } finally {
      fs.closeSync(stream);
    }
    const expectedSize = fs.statSync(file).size;
    expect(expectedSize).toBeGreaterThan(6 * 1024 * 1024);

    expect(
      await executeCliArchiveCommand(['--consent', file], deps),
    ).toMatchObject({ ok: true });
    expect(uploaded.byteLength).toBe(expectedSize);
    expect(uploaded.bytes?.length).toBe(expectedSize);
  });

  it('uploads the exact staged snapshot even when the source file is overwritten in place or appended during claim', async () => {
    const { file, deps, uploaded } = fixture();
    const originalBytes = fs.readFileSync(file);
    vi.mocked(deps.claim).mockImplementation(async () => {
      // Same-length in-place overwrite on the exact same inode + trailing append:
      // neither can alter the private staged snapshot that passed validation.
      const mutatedSameLength = Buffer.from(
        originalBytes.toString('utf8').replace('"session-1"', '"session-X"'),
        'utf8',
      );
      expect(mutatedSameLength.length).toBe(originalBytes.length);
      const writeFd = fs.openSync(file, 'r+');
      try {
        fs.writeSync(
          writeFd,
          mutatedSameLength,
          0,
          mutatedSameLength.length,
          0,
        );
      } finally {
        fs.closeSync(writeFd);
      }
      fs.appendFileSync(
        file,
        JSON.stringify({ type: 'session_meta', payload: { id: 'intruder' } }) +
          '\nnot-json\n',
      );
    });

    expect(
      await executeCliArchiveCommand(['--consent', file], deps),
    ).toMatchObject({ ok: true });
    expect(uploaded.byteLength).toBe(originalBytes.length);
    expect(uploaded.bytes).toEqual(originalBytes);
  });

  it('aborts createBoundedFdReadStream if the underlying descriptor shrinks below byteLength', async () => {
    const { file } = fixture();
    const fd = fs.openSync(file, 'r+');
    try {
      const originalLength = fs.fstatSync(fd).size;
      fs.ftruncateSync(fd, 4);
      const stream = createBoundedFdReadStream(fd, originalLength);
      await expect(readStreamToBuffer(stream)).rejects.toThrow(
        'archive-truncated',
      );
    } finally {
      fs.closeSync(fd);
    }
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
    const { file, deps, uploaded } = fixture();
    expect(
      await executeCliArchiveCommand(['--consent', file], deps),
    ).toMatchObject({ ok: true });
    expect(uploaded.object).toBe(
      'cli-consented-v1/codex/session-1/capture-1.jsonl',
    );
    expect(uploaded.bytes?.length).toBeGreaterThan(0);
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
    'mid-stream-invalid-json',
    'json-array-line',
    'oversized-single-line',
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
    if (scenario === 'mid-stream-invalid-json')
      fs.appendFileSync(file, 'corrupt {{{ line\n');
    if (scenario === 'json-array-line') fs.appendFileSync(file, '[1, 2, 3]\n');
    if (scenario === 'oversized-single-line') {
      deps.maxLineBytes = 1024;
      fs.appendFileSync(file, 'x'.repeat(4096));
    }
    const args = scenario === 'missing-consent' ? [file] : ['--consent', file];
    expect(await executeCliArchiveCommand(args, deps)).toMatchObject({
      ok: false,
    });
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it('refuses files exceeding the safety ceiling, empty files, and symlinks before reading them', () => {
    const { file } = fixture();
    expect(() => openCliArchiveFd(file, 10)).toThrow('archive-size');
    const emptyFile = `${file}.empty`;
    fs.writeFileSync(emptyFile, '');
    expect(() => openCliArchiveFd(emptyFile)).toThrow('archive-size');
    fs.symlinkSync(file, `${file}.link`);
    expect(() => openCliArchiveFd(`${file}.link`)).toThrow();
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
