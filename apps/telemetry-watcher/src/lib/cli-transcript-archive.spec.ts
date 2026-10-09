import { logger } from '@agent-lcars/logging';
import {
  CLI_TRANSCRIPT_MAX_BYTES,
  getTranscriptAdapter,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  archiveCliTranscript,
  isCliArchiveAllowed,
  parseCliArchivePolicy,
  readCliArchive,
} from './cli-transcript-archive';
import { WatcherDaemon } from './daemon';
import { WatchRootConfig } from './watch-roots';

const now = '2026-10-09T10:00:00.000Z';
const policy = {
  bucket: 'cli-archives',
  sessionIds: ['consented'],
  enabledAfter: '2026-10-09T00:00:00.000Z',
};
const root: WatchRootConfig = {
  path: '/transcripts',
  adapter: 'claude-code',
  projectDirAllowlist: ['-work-allowed*'],
};
const file = '/transcripts/-work-allowed/consented.jsonl';
function transcript(
  id = 'consented',
  cwd = '/work/allowed',
  timestamp = '2026-10-09T09:00:00.000Z',
) {
  return JSON.stringify({
    type: 'user',
    sessionId: id,
    timestamp,
    cwd,
    message: { role: 'user', content: 'private session content' },
  });
}
const summary = () =>
  getTranscriptAdapter('claude-code')!.reduce([transcript()])[0]!;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('CLI archive consent and boundaries', () => {
  it('is disabled by default and rejects broad/invalid consent', () => {
    expect(parseCliArchivePolicy()).toBeUndefined();
    expect(parseCliArchivePolicy(JSON.stringify(policy))).toEqual(policy);
    for (const value of [
      { ...policy, sessionIds: ['*'] },
      { ...policy, enabledAfter: '' },
      { ...policy, sessionIds: [] },
    ]) {
      expect(() => parseCliArchivePolicy(JSON.stringify(value))).toThrow();
    }
  });

  it('requires a restrictive existing gate and rejects excluded projects, cwd and paths', () => {
    expect(isCliArchiveAllowed(root, file, summary())).toBe(true);
    expect(
      isCliArchiveAllowed(
        { ...root, projectDirAllowlist: ['*'] },
        file,
        summary(),
      ),
    ).toBe(false);
    expect(
      isCliArchiveAllowed(
        root,
        '/transcripts/excluded/consented.jsonl',
        summary(),
      ),
    ).toBe(false);
    expect(
      isCliArchiveAllowed(
        root,
        '/outside/-work-allowed/consented.jsonl',
        summary(),
      ),
    ).toBe(false);
    expect(
      isCliArchiveAllowed(
        { ...root, cwdAllowlist: ['/work/other*'] },
        file,
        summary(),
      ),
    ).toBe(false);
  });

  it('uploads only the consented single-session bytes and returns a bounded detail reference', async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    const result = await archiveCliTranscript({
      policy,
      root,
      file,
      summary: summary(),
      now,
      read: () => transcript(),
      upload,
    });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: policy.bucket,
        object: 'cli/host/claude-code/consented.jsonl',
        contents: transcript(),
      }),
    );
    expect(result).toEqual({
      cliTranscriptArchive: {
        status: 'available',
        expiresAt: '2026-11-08T09:00:00.000Z',
      },
      transcriptGcsUri:
        'gs://cli-archives/cli/host/claude-code/consented.jsonl',
    });
  });

  it('rejects mixed-session, changed cwd, historic and malformed upload bytes', async () => {
    const upload = vi.fn();
    for (const contents of [
      transcript() + '\n' + transcript('excluded'),
      transcript('consented', '/excluded'),
      transcript('consented', '/work/allowed', '2026-10-08T09:00:00Z'),
      transcript() + '\nnot-json',
    ]) {
      await expect(
        archiveCliTranscript({
          policy,
          root: { ...root, cwdAllowlist: ['/work/allowed'] },
          file,
          summary: summary(),
          now,
          read: () => contents,
          upload,
        }),
      ).rejects.toThrow();
    }
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects earlier excluded cwd and relocation contexts even when the last cwd is allowed', async () => {
    const upload = vi.fn();
    for (const earlier of [
      transcript('consented', '/work/excluded'),
      JSON.stringify({
        type: 'system',
        sessionId: 'consented',
        relocatedCwd: '/work/excluded',
      }),
    ]) {
      await expect(
        archiveCliTranscript({
          policy,
          root,
          file,
          summary: summary(),
          now,
          read: () => earlier + '\n' + transcript(),
          upload,
        }),
      ).rejects.toThrow('excluded cwd context');
    }
    expect(upload).not.toHaveBeenCalled();
  });

  it('validates both Codex session metadata aliases and every turn context', async () => {
    const codexRoot: WatchRootConfig = {
      path: '/transcripts',
      adapter: 'codex',
      recursive: true,
      cwdAllowlist: ['/work/allowed*'],
    };
    const meta = (fields: Record<string, string>) =>
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-09T09:00:00Z',
        payload: { cwd: '/work/allowed', ...fields },
      });
    const accepted = meta({ id: 'consented' });
    const codexSummary = getTranscriptAdapter('codex')!.reduce([accepted])[0]!;
    const upload = vi.fn().mockResolvedValue(undefined);
    await expect(
      archiveCliTranscript({
        policy,
        root: codexRoot,
        file,
        summary: codexSummary,
        now,
        read: () => accepted,
        upload,
      }),
    ).resolves.toMatchObject({ cliTranscriptArchive: { status: 'available' } });
    upload.mockClear();
    for (const earlier of [
      meta({ session_id: 'excluded' }),
      meta({ id: 'consented', session_id: 'excluded' }),
      JSON.stringify({
        type: 'turn_context',
        payload: { cwd: '/work/excluded' },
      }),
    ]) {
      await expect(
        archiveCliTranscript({
          policy,
          root: codexRoot,
          file,
          summary: codexSummary,
          now,
          read: () => earlier + '\n' + accepted,
          upload,
        }),
      ).rejects.toThrow(/another session|excluded cwd context/);
    }
    expect(upload).not.toHaveBeenCalled();
  });

  it('bounds descriptor reads and rejects both leaf and parent symlink escapes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-archive-'));
    directories.push(directory);
    const watch = path.join(directory, 'watch');
    fs.mkdirSync(watch);
    const local = path.join(watch, 'session.jsonl');
    fs.writeFileSync(local, transcript());
    const scopedRoot = { ...root, path: watch };
    expect(readCliArchive(local, scopedRoot)).toBe(transcript());
    fs.truncateSync(local, CLI_TRANSCRIPT_MAX_BYTES + 1);
    expect(() => readCliArchive(local, scopedRoot)).toThrow('size limit');
    const excluded = path.join(watch, 'excluded');
    fs.mkdirSync(excluded);
    fs.writeFileSync(path.join(excluded, 'session.jsonl'), transcript());
    fs.symlinkSync(excluded, path.join(watch, 'allowed'));
    expect(() =>
      readCliArchive(path.join(watch, 'allowed', 'session.jsonl'), scopedRoot),
    ).toThrow('symlinked directory');
    const outside = path.join(directory, 'outside.jsonl');
    fs.writeFileSync(outside, transcript());
    fs.symlinkSync(outside, path.join(watch, 'link.jsonl'));
    expect(() =>
      readCliArchive(path.join(watch, 'link.jsonl'), scopedRoot),
    ).toThrow();
    fs.symlinkSync(directory, path.join(watch, 'parent'));
    expect(() =>
      readCliArchive(path.join(watch, 'parent', 'outside.jsonl'), scopedRoot),
    ).toThrow();
  });
});

describe('host daemon CLI archive path', () => {
  function daemon(
    options: {
      contents?: string;
      configured?: boolean;
      live?: boolean;
      size?: number;
      upload?: ReturnType<typeof vi.fn<typeof archiveCliTranscript>>;
      watchRoot?: WatchRootConfig;
      at?: () => string;
    } = {},
  ) {
    const writes: import('@agent-lcars/telemetry').SessionWrite[] = [];
    const upload =
      options.upload ??
      vi.fn().mockResolvedValue({
        cliTranscriptArchive: {
          status: 'available',
          expiresAt: '2026-11-08T09:00:00Z',
        },
        transcriptGcsUri:
          'gs://cli-archives/cli/host/claude-code/consented.jsonl',
      });
    const watcher = new WatcherDaemon({
      host: 'test',
      watchRoots: [options.watchRoot ?? root],
      heartbeatIntervalMs: 10000,
      stalenessWindowMs: 50000,
      store: {
        upsertSession: async (write) => {
          writes.push(write);
        },
      },
      cliArchivePolicy: options.configured === false ? undefined : policy,
      archiveCliTranscript: upload,
      discover: () => [file],
      readFile: () => options.contents ?? transcript(),
      statFile: () => ({ mtimeMs: 1, size: options.size ?? 200 }),
      isProcessAliveForCwd: () => options.live ?? false,
      now: options.at ?? (() => now),
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
    });
    return { watcher, writes, upload };
  }

  it('archives an allowed ended session once and attaches the archive to its ledger write', async () => {
    const { watcher, writes, upload } = daemon();
    await watcher.tick();
    await watcher.tick();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(writes[0].doc).toMatchObject({
      source: 'cli',
      renderable: true,
      cliTranscriptArchive: { status: 'available' },
      transcriptGcsUri: expect.stringContaining('gs://'),
    });
  });

  it('does not upload when disabled, unconsented, historic, alive, expired or cwd-excluded', async () => {
    for (const options of [
      { configured: false },
      { contents: transcript('not-consented') },
      {
        contents: transcript(
          'consented',
          '/work/allowed',
          '2026-10-08T09:00:00Z',
        ),
      },
      { live: true },
      { at: () => '2026-11-20T00:00:00Z' },
      { watchRoot: { ...root, cwdAllowlist: ['/excluded'] } },
    ]) {
      const { watcher, writes, upload } = daemon(options);
      await watcher.tick();
      expect(upload).not.toHaveBeenCalled();
      for (const write of writes)
        expect(write.doc.transcriptGcsUri).toBeUndefined();
    }
  });

  it('keeps malformed private transcript excerpts out of daemon logs', async () => {
    const privateMarker = 'PII42';
    const contents = transcript() + '\n' + privateMarker;
    const upload = vi.fn().mockResolvedValue(undefined);
    const archive = vi.fn<typeof archiveCliTranscript>((options) =>
      archiveCliTranscript({ ...options, read: () => contents, upload }),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const { watcher, writes } = daemon({ contents, upload: archive });
      await watcher.tick();
      expect(archive).toHaveBeenCalledTimes(1);
      expect(upload).not.toHaveBeenCalled();
      expect(writes[0].doc).toMatchObject({
        sessionId: 'consented',
        source: 'cli',
        liveness: 'ended',
        cliTranscriptArchive: { status: 'failed' },
      });
      expect(writes[0].doc.transcriptGcsUri).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      for (const call of warn.mock.calls) {
        for (const argument of call) {
          const logged =
            argument instanceof Error
              ? {
                  name: argument.name,
                  message: argument.message,
                  stack: argument.stack,
                  cause: argument.cause,
                }
              : argument;
          expect(JSON.stringify(logged)).not.toContain(privateMarker);
        }
      }
      for (const error of warn.mock.calls
        .flat()
        .filter((argument) => argument instanceof Error)) {
        expect(error.cause).toBeUndefined();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('reports oversize and retries failed archives while continuing summaries', async () => {
    const oversized = daemon({ size: CLI_TRANSCRIPT_MAX_BYTES + 1 });
    await oversized.watcher.tick();
    expect(oversized.upload).not.toHaveBeenCalled();
    expect(oversized.writes[0].doc).toMatchObject({
      cliTranscriptArchive: { status: 'too-large' },
    });
    let at = now;
    const upload = vi
      .fn<typeof archiveCliTranscript>()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValue({
        cliTranscriptArchive: {
          status: 'available',
          expiresAt: '2026-11-08T09:00:00Z',
        },
        transcriptGcsUri:
          'gs://cli-archives/cli/host/claude-code/consented.jsonl',
      });
    const failed = daemon({ upload, at: () => at });
    await failed.watcher.tick();
    expect(failed.writes[0].doc).toMatchObject({
      cliTranscriptArchive: { status: 'failed' },
    });
    await failed.watcher.tick();
    expect(upload).toHaveBeenCalledTimes(1);
    at = '2026-10-09T10:01:01Z';
    await failed.watcher.tick();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(failed.writes.at(-1)?.doc).toMatchObject({
      cliTranscriptArchive: { status: 'available' },
    });
  });
});
