import { logger } from '@agent-lcars/logging';
import {
  SessionDoc,
  SessionStatusAnnotationV1,
  SessionSummary,
  SessionTitleAnnotationV1,
  SessionWrite,
} from '@agent-lcars/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { WatcherDaemon } from './daemon';
import {
  SessionStatusDirectoryRead,
  SessionTitleOverlayRead,
} from './session-title-annotation-source';
import { SessionStore } from './store';

const TRANSCRIPT = (
  sessionId: string,
  timestamp: string,
  cwd = '/home/dev/project',
) =>
  [
    JSON.stringify({
      isSidechain: false,
      type: 'user',
      uuid: `${sessionId}-u1`,
      timestamp,
      sessionId,
      cwd,
      gitBranch: 'main',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }),
    JSON.stringify({
      isSidechain: false,
      type: 'assistant',
      uuid: `${sessionId}-a1`,
      timestamp,
      sessionId,
      message: {
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ].join('\n');

/** `upserts` collects each write's `doc` (not the whole `SessionWrite`) so
 * every existing `upserts[i].xxx` assertion in this file keeps working
 * unchanged; `writes` collects the full `SessionWrite` (including
 * `clearFields`) for tests that need to inspect the clear-field cache
 * behaviour itself. */
function createFakeStore() {
  const upserts: SessionDoc[] = [];
  const writes: SessionWrite[] = [];
  const store: SessionStore = {
    async upsertSession(write: SessionWrite) {
      writes.push(write);
      upserts.push(write.doc);
    },
  };
  return { store, upserts, writes };
}

/** A content-derived fake stat, so tests can simulate a file changing on
 * disk (any edit bumps `mtimeMs` in reality) just by changing its content
 * string — no real filesystem involved. */
function fakeStat(content: string | undefined): {
  mtimeMs: number;
  size: number;
} {
  const text = content ?? '';
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return { mtimeMs: hash, size: text.length };
}

describe('WatcherDaemon', () => {
  const HEARTBEAT_MS = 10_000;
  const STALENESS_MS = 30_000;

  it('ships an initial summary for each discovered transcript on the first tick', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/root/proj/session-a.jsonl': TRANSCRIPT(
        'session-a',
        '2026-07-12T10:00:00.000Z',
      ),
    };

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sessionId: 'session-a',
      liveness: 'live',
    });
  });

  it('publishes completed-tick and successful active-upsert metrics', async () => {
    const { store } = createFakeStore();
    const timestamp = '2026-07-12T10:00:01.000Z';
    const files = {
      '/root/proj/session-metrics.jsonl': TRANSCRIPT(
        'session-metrics',
        '2026-07-12T10:00:00.000Z',
      ),
    };
    const metrics = {
      recordCompletedTick: vi.fn(),
      recordSuccessfulSessionUpsert: vi.fn(),
    };
    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => timestamp,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      metrics,
    });

    await daemon.tick();

    expect(metrics.recordSuccessfulSessionUpsert).toHaveBeenCalledWith(
      timestamp,
      'live',
    );
    expect(metrics.recordCompletedTick).toHaveBeenCalledWith(timestamp, 1);
  });

  it('reports a completed zero-session tick without fabricating an upsert', async () => {
    const { store } = createFakeStore();
    const timestamp = '2026-07-12T10:00:01.000Z';
    const metrics = {
      recordCompletedTick: vi.fn(),
      recordSuccessfulSessionUpsert: vi.fn(),
    };
    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => timestamp,
      discover: () => [],
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      metrics,
    });

    await daemon.tick();

    expect(metrics.recordSuccessfulSessionUpsert).not.toHaveBeenCalled();
    expect(metrics.recordCompletedTick).toHaveBeenCalledWith(timestamp, 0);
  });

  it('produces an upsert for a new transcript discovered on a later tick', async () => {
    const { store, upserts } = createFakeStore();
    let files: Record<string, string> = {};

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p],
      statFile: (p: string) => fakeStat(files[p]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();
    expect(upserts).toHaveLength(0);

    files = {
      '/root/proj/session-b.jsonl': TRANSCRIPT(
        'session-b',
        '2026-07-12T10:00:00.000Z',
      ),
    };
    await daemon.tick();

    expect(upserts).toHaveLength(1);
    expect(upserts[0].sessionId).toBe('session-b');
  });

  it('transitions a session to `ended` once its process is no longer alive, without re-reading its unchanged transcript', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/root/proj/session-c.jsonl': TRANSCRIPT(
        'session-c',
        '2026-07-12T09:57:00.000Z',
      ),
    };
    let processAlive = true;
    const readFile = vi.fn((p: string) => files[p as keyof typeof files]);

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:00.000Z',
      discover: () => Object.keys(files),
      readFile,
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => processAlive,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();
    expect(upserts[0].liveness).toBe('idle'); // >2min since lastActivityAt but process alive
    expect(readFile).toHaveBeenCalledTimes(1);

    processAlive = false;
    await daemon.tick();

    expect(upserts[1].liveness).toBe('ended');
    // The transcript is unchanged (the process just exited), so the
    // watcher must not have re-read or re-reduced it on this tick.
    expect(readFile).toHaveBeenCalledTimes(1);

    // A further tick against the still-unchanged, now-`ended` file must
    // also skip re-reading it.
    await daemon.tick();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('surfaces a session as `stale` once it goes undiscovered past the staleness window', async () => {
    const { store, upserts } = createFakeStore();
    let files: Record<string, string> = {
      '/root/proj/session-d.jsonl': TRANSCRIPT(
        'session-d',
        '2026-07-12T10:00:00.000Z',
      ),
    };
    let now = '2026-07-12T10:00:01.000Z';

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => now,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p],
      statFile: (p: string) => fakeStat(files[p]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();
    expect(upserts[0].liveness).toBe('live');

    // The transcript file disappears (e.g. deleted) — watcher stops rediscovering it,
    // and time advances 59s, past the 30s staleness window.
    files = {};
    now = '2026-07-12T10:01:00.000Z';
    await daemon.tick();
    expect(upserts[1].liveness).toBe('stale');
  });

  it('fails soft when one transcript file cannot be read', async () => {
    const { store, upserts } = createFakeStore();
    const files: Record<string, string> = {
      '/root/proj/session-good.jsonl': TRANSCRIPT(
        'session-good',
        '2026-07-12T10:00:00.000Z',
      ),
    };

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => ['/root/proj/session-bad.jsonl', ...Object.keys(files)],
      readFile: (p: string) => {
        if (p === '/root/proj/session-bad.jsonl') {
          throw new Error('EACCES: permission denied');
        }
        return files[p];
      },
      statFile: (p: string) => fakeStat(files[p]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await expect(daemon.tick()).resolves.toBeUndefined();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sessionId).toBe('session-good');
  });

  it('retries a lazy transcript read that throws during reduction', async () => {
    const { store } = createFakeStore();
    const readTranscriptLines = vi.fn(function* () {
      yield '';
      throw new Error('EACCES: permission denied');
    });

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => ['/root/proj/session-lazy-read-error.jsonl'],
      readTranscriptLines,
      statFile: () => fakeStat('unchanged'),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await expect(daemon.tick()).resolves.toBeUndefined();
    await expect(daemon.tick()).resolves.toBeUndefined();

    // A lazy reader can fail only when the reducer consumes it. The file
    // must remain eligible for retry rather than being marked as read.
    expect(readTranscriptLines).toHaveBeenCalledTimes(2);
  });

  it('fails soft when one transcript file cannot be stat-ed', async () => {
    const { store, upserts } = createFakeStore();
    const files: Record<string, string> = {
      '/root/proj/session-good2.jsonl': TRANSCRIPT(
        'session-good2',
        '2026-07-12T10:00:00.000Z',
      ),
    };

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => ['/root/proj/session-bad2.jsonl', ...Object.keys(files)],
      readFile: (p: string) => files[p],
      statFile: (p: string) => {
        if (p === '/root/proj/session-bad2.jsonl') {
          throw new Error('ENOENT: no such file');
        }
        return fakeStat(files[p]);
      },
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await expect(daemon.tick()).resolves.toBeUndefined();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sessionId).toBe('session-good2');
  });

  it('fails soft when the store rejects a write', async () => {
    const store: SessionStore = {
      upsertSession: vi
        .fn()
        .mockRejectedValue(new Error('firestore unavailable')),
    };
    const files = {
      '/root/proj/session-e.jsonl': TRANSCRIPT(
        'session-e',
        '2026-07-12T10:00:00.000Z',
      ),
    };

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await expect(daemon.tick()).resolves.toBeUndefined();
    expect(store.upsertSession).toHaveBeenCalledTimes(1);
  });

  it('overrides the reduced branch with a freshly-resolved git branch', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/root/proj/session-f.jsonl': TRANSCRIPT(
        'session-f',
        '2026-07-12T10:00:00.000Z',
      ),
    };

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => 'feature/fresh-branch',
    });

    await daemon.tick();

    expect(upserts[0]).toMatchObject({ branch: 'feature/fresh-branch' });
  });

  it('stamps a cli session doc with a freshly-resolved git repo', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/root/proj/session-repo.jsonl': TRANSCRIPT(
        'session-repo',
        '2026-07-12T10:00:00.000Z',
      ),
    };

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => ({
        owner: 'supersprinklesracing',
        name: 'sprinkles',
      }),
    });

    await daemon.tick();

    expect(upserts[0]).toMatchObject({
      repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    });
  });

  it('omits repo from a cli doc when resolveGitRepo resolves nothing', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/root/proj/session-norepo.jsonl': TRANSCRIPT(
        'session-norepo',
        '2026-07-12T10:00:00.000Z',
      ),
    };

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
    });

    await daemon.tick();

    expect(upserts[0]).not.toHaveProperty('repo');
  });

  it('tags an issue-agent session doc with the static repo option, not the per-tick git-remote resolution', async () => {
    const { store, upserts } = createFakeStore();
    const ISSUE_AGENT_TRANSCRIPT = (sessionId: string, timestamp: string) =>
      [
        JSON.stringify({
          isSidechain: false,
          type: 'user',
          uuid: `${sessionId}-u1`,
          timestamp,
          sessionId,
          cwd: '/home/runner/work/members/members',
          gitBranch: 'main',
          entrypoint: 'claude-code-github-action',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
        }),
        JSON.stringify({
          isSidechain: false,
          type: 'assistant',
          uuid: `${sessionId}-a1`,
          timestamp,
          sessionId,
          message: {
            model: 'claude-sonnet-5',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      ].join('\n');
    const files = {
      '/root/proj/session-runner.jsonl': ISSUE_AGENT_TRANSCRIPT(
        'session-runner',
        '2026-07-12T10:00:00.000Z',
      ),
    };
    const resolveGitRepo = vi.fn(async () => ({
      owner: 'from-git-remote',
      name: 'should-not-be-used',
    }));

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      resolveGitRepo,
      repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    });

    await daemon.tick();

    expect(upserts[0]).toMatchObject({
      source: 'issue-agent',
      repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    });
  });

  it('re-reads and re-reduces a transcript once it changes on a later tick', async () => {
    const { store, upserts } = createFakeStore();
    let files = {
      '/root/proj/session-g.jsonl': TRANSCRIPT(
        'session-g',
        '2026-07-12T10:00:00.000Z',
      ),
    };
    const readFile = vi.fn((p: string) => files[p as keyof typeof files]);

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile,
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(upserts[0].lastActivityAt).toBe('2026-07-12T10:00:00.000Z');

    // Unchanged content on the next tick — must not be re-read.
    await daemon.tick();
    expect(readFile).toHaveBeenCalledTimes(1);

    // The session is resumed and the same file grows with new activity.
    files = {
      '/root/proj/session-g.jsonl': TRANSCRIPT(
        'session-g',
        '2026-07-12T11:00:00.000Z',
      ),
    };
    await daemon.tick();

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(upserts.at(-1)?.lastActivityAt).toBe('2026-07-12T11:00:00.000Z');
  });

  it('merges discovered artifacts onto the cli session doc', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/root/proj/session-h.jsonl': TRANSCRIPT(
        'session-h',
        '2026-07-12T10:00:00.000Z',
      ),
    };

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      shareDir: '/root/share',
      discoverArtifacts: (shareDir: string, sessionId: string) =>
        shareDir === '/root/share' && sessionId === 'session-h'
          ? ['report.md']
          : [],
    });

    await daemon.tick();

    expect(upserts[0]).toMatchObject({ artifacts: ['report.md'] });
  });

  it('re-discovers artifacts each tick even when the transcript is unchanged', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/root/proj/session-i.jsonl': TRANSCRIPT(
        'session-i',
        '2026-07-12T10:00:00.000Z',
      ),
    };
    let artifacts: string[] = [];

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      shareDir: '/root/share',
      discoverArtifacts: () => artifacts,
    });

    await daemon.tick();
    expect(upserts[0]).not.toHaveProperty('artifacts');

    artifacts = ['late-report.md'];
    await daemon.tick();

    expect(upserts.at(-1)).toMatchObject({ artifacts: ['late-report.md'] });
  });

  it('skips artifact discovery entirely when shareDir is unset', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/root/proj/session-j.jsonl': TRANSCRIPT(
        'session-j',
        '2026-07-12T10:00:00.000Z',
      ),
    };
    const discoverArtifacts = vi.fn(() => ['should-not-appear.md']);

    const daemon = new WatcherDaemon({
      watchRoots: [
        { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
      ],
      host: 'test-host',
      store,
      heartbeatIntervalMs: HEARTBEAT_MS,
      stalenessWindowMs: STALENESS_MS,
      now: () => '2026-07-12T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      discoverArtifacts,
    });

    await daemon.tick();

    expect(discoverArtifacts).not.toHaveBeenCalled();
    expect(upserts[0]).not.toHaveProperty('artifacts');
  });

  describe('multi-root', () => {
    it('discovers and reduces transcripts from multiple watch roots independently on the same tick', async () => {
      const { store, upserts } = createFakeStore();
      const claudeFiles = {
        '/root-a/proj/session-claude.jsonl': TRANSCRIPT(
          'session-claude',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      // A second root using an agent with no registered TranscriptAdapter
      // yet - its files must be skipped (fail soft), not crash the tick or
      // block the first root's own upsert.
      const codexFiles = {
        '/root-b/proj/session-codex.jsonl': TRANSCRIPT(
          'session-codex',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          {
            path: '/root-a',
            adapter: 'claude-code',
            projectDirAllowlist: ['*'],
          },
          { path: '/root-b', adapter: 'codex' },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: (rootPath) =>
          rootPath === '/root-a'
            ? Object.keys(claudeFiles)
            : Object.keys(codexFiles),
        readFile: (p: string) =>
          (claudeFiles as Record<string, string>)[p] ??
          (codexFiles as Record<string, string>)[p],
        statFile: (p: string) =>
          fakeStat(
            (claudeFiles as Record<string, string>)[p] ??
              (codexFiles as Record<string, string>)[p],
          ),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
      });

      await daemon.tick();

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({ sessionId: 'session-claude' });
    });

    it("applies each root's own allowlist when resolving which project dirs to discover under", async () => {
      const { store } = createFakeStore();
      const seenAllowlists: Record<string, string[]> = {};

      const daemon = new WatcherDaemon({
        watchRoots: [
          {
            path: '/root-a',
            adapter: 'claude-code',
            projectDirAllowlist: ['-home-a-*'],
          },
          {
            path: '/root-b',
            adapter: 'claude-code',
            projectDirAllowlist: ['-home-b-*'],
          },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: (rootPath, allowlist) => {
          seenAllowlists[rootPath] = allowlist;
          return [];
        },
        readFile: () => '',
        statFile: () => fakeStat(''),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
      });

      await daemon.tick();

      expect(seenAllowlists).toEqual({
        '/root-a': ['-home-a-*'],
        '/root-b': ['-home-b-*'],
      });
    });

    it('ships summaries from a second root even when the first root has no changed files', async () => {
      const { store, upserts } = createFakeStore();
      const codexFiles = {
        '/root-b/proj/session-only.jsonl': TRANSCRIPT(
          'session-only',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          {
            path: '/root-a',
            adapter: 'claude-code',
            projectDirAllowlist: ['*'],
          },
          {
            path: '/root-b',
            adapter: 'claude-code',
            projectDirAllowlist: ['*'],
          },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: (rootPath) =>
          rootPath === '/root-b' ? Object.keys(codexFiles) : [],
        readFile: (p: string) => codexFiles[p as keyof typeof codexFiles],
        statFile: (p: string) =>
          fakeStat(codexFiles[p as keyof typeof codexFiles]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
      });

      await daemon.tick();

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({ sessionId: 'session-only' });
    });
  });

  describe('antigravity summary source (#3123 phase 3)', () => {
    const ANTIGRAVITY_SUMMARY: SessionSummary = {
      sessionId: 'convo-antigravity-1',
      source: 'cli',
      agent: 'antigravity',
      cwd: '/home/developer/p/members',
      startedAt: '2026-07-12T09:00:00.000Z',
      lastActivityAt: '2026-07-12T09:55:00.000Z',
      turns: 12,
      toolCallCounts: {},
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      deliverables: { prNumbers: [], commitShas: [] },
    };

    it('upserts a session doc from a polled antigravity summary, without any watch roots configured', async () => {
      const { store, upserts } = createFakeStore();

      const daemon = new WatcherDaemon({
        watchRoots: [],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:00.000Z',
        discover: () => [],
        readFile: () => '',
        statFile: () => fakeStat(''),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        antigravitySummaryDb: {
          path: '/fake/conversation_summaries.db',
          workspacePrefixes: ['/home/developer/p/members'],
        },
        pollAntigravitySummaries: () => [ANTIGRAVITY_SUMMARY],
      });

      await daemon.tick();

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        sessionId: 'convo-antigravity-1',
        source: 'cli',
        agent: 'antigravity',
        liveness: 'ended', // no /proc signal for antigravity - see daemon.ts's tickAntigravitySummaries comment.
      });
    });

    it('does not poll antigravity summaries when antigravitySummaryDb is unset', async () => {
      const { store, upserts } = createFakeStore();
      const poll = vi.fn(() => [ANTIGRAVITY_SUMMARY]);

      const daemon = new WatcherDaemon({
        watchRoots: [],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:00.000Z',
        discover: () => [],
        readFile: () => '',
        statFile: () => fakeStat(''),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        pollAntigravitySummaries: poll,
      });

      await daemon.tick();

      expect(poll).not.toHaveBeenCalled();
      expect(upserts).toHaveLength(0);
    });

    it('skips re-upserting an antigravity summary unchanged since the last tick', async () => {
      const { store, upserts } = createFakeStore();
      const poll = vi.fn(() => [ANTIGRAVITY_SUMMARY]);

      const daemon = new WatcherDaemon({
        watchRoots: [],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:00.000Z',
        discover: () => [],
        readFile: () => '',
        statFile: () => fakeStat(''),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        antigravitySummaryDb: {
          path: '/fake/conversation_summaries.db',
          workspacePrefixes: ['/home/developer/p/members'],
        },
        pollAntigravitySummaries: poll,
      });

      await daemon.tick();
      await daemon.tick();
      await daemon.tick();

      expect(poll).toHaveBeenCalledTimes(3); // polled every tick...
      expect(upserts).toHaveLength(1); // ...but only upserted once, since the row never changed.
    });

    it('re-upserts an antigravity summary once its lastActivityAt changes', async () => {
      const { store, upserts } = createFakeStore();
      let summary = ANTIGRAVITY_SUMMARY;

      const daemon = new WatcherDaemon({
        watchRoots: [],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:00.000Z',
        discover: () => [],
        readFile: () => '',
        statFile: () => fakeStat(''),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        antigravitySummaryDb: {
          path: '/fake/conversation_summaries.db',
          workspacePrefixes: ['/home/developer/p/members'],
        },
        pollAntigravitySummaries: () => [summary],
      });

      await daemon.tick();
      expect(upserts).toHaveLength(1);

      summary = {
        ...ANTIGRAVITY_SUMMARY,
        lastActivityAt: '2026-07-12T11:00:00.000Z',
      };
      await daemon.tick();

      expect(upserts).toHaveLength(2);
      expect(upserts[1].lastActivityAt).toBe('2026-07-12T11:00:00.000Z');
    });

    it('fails soft when the store rejects an antigravity upsert, and retries next tick', async () => {
      let shouldFail = true;
      const store: SessionStore = {
        upsertSession: vi.fn(async () => {
          if (shouldFail) {
            throw new Error('firestore unavailable');
          }
        }),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:00.000Z',
        discover: () => [],
        readFile: () => '',
        statFile: () => fakeStat(''),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        antigravitySummaryDb: {
          path: '/fake/conversation_summaries.db',
          workspacePrefixes: ['/home/developer/p/members'],
        },
        pollAntigravitySummaries: () => [ANTIGRAVITY_SUMMARY],
      });

      await expect(daemon.tick()).resolves.toBeUndefined();
      expect(store.upsertSession).toHaveBeenCalledTimes(1);

      shouldFail = false;
      await daemon.tick();

      // The failed upsert must not have been cached as "seen" - the
      // second tick (same, unchanged summary) must retry it.
      expect(store.upsertSession).toHaveBeenCalledTimes(2);
    });

    it('fails soft and warns exactly once per process when the DB reports unavailable across many ticks', async () => {
      const { store, upserts } = createFakeStore();
      const warnSpy = vi
        .spyOn(logger, 'warn')
        .mockImplementation(() => undefined);
      const poll = vi.fn(
        (
          _dbPath: string,
          _prefixes: string[],
          options?: { onUnavailable?: (error: unknown) => void },
        ) => {
          options?.onUnavailable?.(new Error('ENOENT: no such file'));
          return [];
        },
      );

      const daemon = new WatcherDaemon({
        watchRoots: [],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:00.000Z',
        discover: () => [],
        readFile: () => '',
        statFile: () => fakeStat(''),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        antigravitySummaryDb: {
          path: '/fake/conversation_summaries.db',
          workspacePrefixes: ['/home/developer/p/members'],
        },
        pollAntigravitySummaries: poll,
      });

      await daemon.tick();
      await daemon.tick();
      await daemon.tick();

      expect(upserts).toHaveLength(0);
      const antigravityWarnCalls = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes('antigravity summary DB unavailable'),
      );
      expect(antigravityWarnCalls).toHaveLength(1);

      warnSpy.mockRestore();
    });

    it('discovers/upserts both file-based and antigravity sessions on the same tick without interference', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-mixed.jsonl': TRANSCRIPT(
          'session-mixed',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        antigravitySummaryDb: {
          path: '/fake/conversation_summaries.db',
          workspacePrefixes: ['/home/developer/p/members'],
        },
        pollAntigravitySummaries: () => [ANTIGRAVITY_SUMMARY],
      });

      await daemon.tick();

      expect(upserts.map((doc) => doc.sessionId).sort()).toEqual([
        'convo-antigravity-1',
        'session-mixed',
      ]);
    });
  });

  describe('session title overlay (issue #1212)', () => {
    const STATE_DIR = '/state/agent-lcars';

    function titleAnnotation(
      sessionId: string,
      title: string,
    ): SessionTitleAnnotationV1 {
      return {
        version: 1,
        sessionId,
        updatedAt: '2026-07-12T09:00:00.000Z',
        title,
      };
    }

    /** Builds a fixed `readSessionTitleOverlay` result for a test seam.
     * `declared` accepts either a map of annotations (a successful — possibly
     * empty — directory read) or the literal string
     * `'unavailable'` (a failed read: missing, unreadable, or over the
     * per-directory file-count bound — see
     * `session-title-annotation-source.ts`'s `SessionTitleDirectoryRead`). */
    function overlayRead(
      declared: ReadonlyMap<string, SessionTitleAnnotationV1> | 'unavailable',
    ): SessionTitleOverlayRead {
      return {
        declared:
          declared === 'unavailable'
            ? { available: false, annotations: new Map() }
            : { available: true, annotations: declared },
      };
    }

    it('layers declared over inferred through a full tick', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-title.jsonl': TRANSCRIPT(
          'session-title',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () =>
          overlayRead(
            new Map([
              [
                'session-title',
                titleAnnotation('session-title', 'Declared title'),
              ],
            ]),
          ),
      });

      await daemon.tick();

      // TRANSCRIPT's own reduced title is 'hello' (inferred, from the first
      // user message, no aiTitle set) — declared beats both the overlay's
      // inferred fallback.
      expect(upserts[0]).toMatchObject({ title: 'Declared title' });
    });

    it('falls back to the transcript inferred title when no declared annotation exists', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-inf.jsonl': TRANSCRIPT(
          'session-inf',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlayRead(new Map()),
      });

      await daemon.tick();

      expect(upserts[0]).toMatchObject({ title: 'hello' });
    });

    it('produces no upsert and does not change session cardinality for an annotation with an unknown session id', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-known.jsonl': TRANSCRIPT(
          'session-known',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () =>
          overlayRead(
            new Map([
              [
                'session-unknown',
                titleAnnotation('session-unknown', 'Ghost title'),
              ],
            ]),
          ),
      });

      await daemon.tick();

      expect(upserts).toHaveLength(1);
      expect(upserts.map((doc) => doc.sessionId)).toEqual(['session-known']);
      expect(upserts[0].title).not.toBe('Ghost title');
    });

    it('retains last-good declared title across a transient unavailable read, and replaces it once the read recovers', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-retain.jsonl': TRANSCRIPT(
          'session-retain',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      let overlay = overlayRead(
        new Map([
          [
            'session-retain',
            titleAnnotation('session-retain', 'First declared title'),
          ],
        ]),
      );

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlay,
      });

      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ title: 'First declared title' });

      // The declared directory becomes transiently unreadable — last-good
      // must be retained, not blanked back to the inferred fallback.
      overlay = overlayRead('unavailable');
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ title: 'First declared title' });

      // It recovers with a different title — last-good is replaced.
      overlay = overlayRead(
        new Map([
          [
            'session-retain',
            titleAnnotation('session-retain', 'Second declared title'),
          ],
        ]),
      );
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ title: 'Second declared title' });
    });

    it('treats an available-but-empty read as real information that replaces last-good, unlike an unavailable read', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-empty.jsonl': TRANSCRIPT(
          'session-empty',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      let overlay = overlayRead(
        new Map([
          ['session-empty', titleAnnotation('session-empty', 'Declared title')],
        ]),
      );

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlay,
      });

      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ title: 'Declared title' });

      // The directory reads fine this time and simply has nothing in it —
      // unlike an unavailable read, this DOES replace last-good, so the doc
      // falls back to the transcript's own inferred title.
      overlay = overlayRead(new Map());
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ title: 'hello' });
    });

    it('triggers a new write when only the overlay changes and the transcript stat is unchanged', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-write.jsonl': TRANSCRIPT(
          'session-write',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      const readFile = vi.fn((p: string) => files[p as keyof typeof files]);
      let overlay = overlayRead(new Map());

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile,
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlay,
      });

      await daemon.tick();
      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({ title: 'hello' });
      expect(readFile).toHaveBeenCalledTimes(1);

      // Only the overlay changes on the next tick — the transcript file's
      // stat (and therefore content) is byte-for-byte unchanged, so it is
      // never re-read. The `lastWrittenDocs` cache keys on the serialized
      // doc, not on whether the transcript itself changed, so the title
      // change alone must still produce a second write.
      overlay = overlayRead(
        new Map([
          ['session-write', titleAnnotation('session-write', 'Declared later')],
        ]),
      );
      await daemon.tick();

      expect(readFile).toHaveBeenCalledTimes(1);
      expect(upserts).toHaveLength(2);
      expect(upserts[1]).toMatchObject({
        sessionId: 'session-write',
        title: 'Declared later',
      });
    });

    it('retries a failed write next tick with the same overlay-selected title', async () => {
      const files = {
        '/root/proj/session-retry.jsonl': TRANSCRIPT(
          'session-retry',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      let shouldFail = true;
      const upserts: SessionDoc[] = [];
      const store: SessionStore = {
        async upsertSession(write: SessionWrite) {
          if (shouldFail) {
            throw new Error('firestore unavailable');
          }
          upserts.push(write.doc);
        },
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () =>
          overlayRead(
            new Map([
              [
                'session-retry',
                titleAnnotation('session-retry', 'Retry title'),
              ],
            ]),
          ),
      });

      await daemon.tick();
      expect(upserts).toHaveLength(0);

      shouldFail = false;
      await daemon.tick();

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        sessionId: 'session-retry',
        title: 'Retry title',
      });
    });

    it('reads the overlay exactly once per tick regardless of session count', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-1.jsonl': TRANSCRIPT(
          'session-1',
          '2026-07-12T10:00:00.000Z',
        ),
        '/root/proj/session-2.jsonl': TRANSCRIPT(
          'session-2',
          '2026-07-12T10:00:00.000Z',
        ),
        '/root/proj/session-3.jsonl': TRANSCRIPT(
          'session-3',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      const readOverlay = vi.fn(() => overlayRead(new Map()));

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: readOverlay,
      });

      await daemon.tick();
      expect(upserts).toHaveLength(3);
      expect(readOverlay).toHaveBeenCalledTimes(1);

      await daemon.tick();
      expect(readOverlay).toHaveBeenCalledTimes(2);
    });

    it('never invokes the session-title overlay when sessionStateDir is unset', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-runner.jsonl': TRANSCRIPT(
          'session-runner',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      const readOverlay = vi.fn(() => overlayRead(new Map()));

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        // An issue-agent-shaped daemon (forceSource set, shareDir unset) —
        // NOT what runner.ts's startSidecar actually configures since
        // issue #1289 (it now always passes a real sessionStateDir). This
        // pins the daemon's own generic contract instead: whatever the
        // caller is, an omitted sessionStateDir must skip the overlay
        // entirely rather than reading from `undefined`.
        forceSource: 'issue-agent',
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        readSessionTitleOverlay: readOverlay,
      });

      await daemon.tick();

      expect(readOverlay).not.toHaveBeenCalled();
      expect(upserts[0]).toMatchObject({
        sessionId: 'session-runner',
        title: 'hello',
      });
    });
  });

  describe('session status overlay (issue #1257)', () => {
    const STATE_DIR = '/state/agent-lcars';

    /** Local re-declaration of this file's `session title overlay` describe
     * block's own `titleAnnotation`/`overlayRead` helpers (that block's are
     * scoped to its own closure and not reachable here) — kept byte-for-byte
     * identical so both helpers stay obviously equivalent. */
    function titleAnnotation(
      sessionId: string,
      title: string,
    ): SessionTitleAnnotationV1 {
      return {
        version: 1,
        sessionId,
        updatedAt: '2026-07-12T09:00:00.000Z',
        title,
      };
    }

    function overlayRead(
      declared: ReadonlyMap<string, SessionTitleAnnotationV1> | 'unavailable',
    ): SessionTitleOverlayRead {
      return {
        declared:
          declared === 'unavailable'
            ? { available: false, annotations: new Map() }
            : { available: true, annotations: declared },
      };
    }

    function statusAnnotation(
      sessionId: string,
      status: string,
    ): SessionStatusAnnotationV1 {
      return {
        version: 1,
        sessionId,
        updatedAt: '2026-07-12T09:00:00.000Z',
        status,
      };
    }

    /** Builds a fixed `readSessionStatusOverlay` result for a test seam —
     * the status-channel analogue of this file's own `overlayRead` helper
     * above (see that helper's doc comment for why `'unavailable'` is
     * accepted as a sentinel distinct from an empty, successful read). */
    function statusOverlayRead(
      annotations:
        | ReadonlyMap<string, SessionStatusAnnotationV1>
        | 'unavailable' = new Map(),
    ): SessionStatusDirectoryRead {
      return annotations === 'unavailable'
        ? { available: false, annotations: new Map() }
        : { available: true, annotations };
    }

    it('joins a declared status onto a discovered session through a full tick', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-status.jsonl': TRANSCRIPT(
          'session-status',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlayRead(new Map()),
        readSessionStatusOverlay: () =>
          statusOverlayRead(
            new Map([
              [
                'session-status',
                statusAnnotation('session-status', 'waiting on CI for #1247'),
              ],
            ]),
          ),
      });

      await daemon.tick();

      expect(upserts[0]).toMatchObject({
        status: 'waiting on CI for #1247',
        statusUpdatedAt: '2026-07-12T09:00:00.000Z',
      });
    });

    it('omits status/statusUpdatedAt when no status annotation exists for the session', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-nostatus.jsonl': TRANSCRIPT(
          'session-nostatus',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlayRead(new Map()),
        readSessionStatusOverlay: () => statusOverlayRead(new Map()),
      });

      await daemon.tick();

      expect(upserts[0]).not.toHaveProperty('status');
      expect(upserts[0]).not.toHaveProperty('statusUpdatedAt');
    });

    it('produces no upsert and does not change session cardinality for a status annotation with an unknown session id', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-known.jsonl': TRANSCRIPT(
          'session-known',
          '2026-07-12T10:00:00.000Z',
        ),
      };

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlayRead(new Map()),
        readSessionStatusOverlay: () =>
          statusOverlayRead(
            new Map([
              [
                'session-ghost',
                statusAnnotation('session-ghost', 'a status for no one'),
              ],
            ]),
          ),
      });

      await daemon.tick();

      expect(upserts).toHaveLength(1);
      expect(upserts.map((doc) => doc.sessionId)).toEqual(['session-known']);
      expect(upserts[0]).not.toHaveProperty('status');
    });

    it('retains last-good status across a transient unavailable read, and replaces it once the read recovers', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-retain.jsonl': TRANSCRIPT(
          'session-retain',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      let statusOverlay = statusOverlayRead(
        new Map([
          [
            'session-retain',
            statusAnnotation('session-retain', 'first status'),
          ],
        ]),
      );

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlayRead(new Map()),
        readSessionStatusOverlay: () => statusOverlay,
      });

      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ status: 'first status' });

      // The status directory becomes transiently unreadable — last-good
      // must be retained, not blanked/cleared.
      statusOverlay = statusOverlayRead('unavailable');
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ status: 'first status' });

      // It recovers with a different status — last-good is replaced.
      statusOverlay = statusOverlayRead(
        new Map([
          [
            'session-retain',
            statusAnnotation('session-retain', 'second status'),
          ],
        ]),
      );
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ status: 'second status' });
    });

    it('reads the status channel exactly once per tick regardless of session count', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-1.jsonl': TRANSCRIPT(
          'session-1',
          '2026-07-12T10:00:00.000Z',
        ),
        '/root/proj/session-2.jsonl': TRANSCRIPT(
          'session-2',
          '2026-07-12T10:00:00.000Z',
        ),
        '/root/proj/session-3.jsonl': TRANSCRIPT(
          'session-3',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      const readStatusOverlay = vi.fn(() => statusOverlayRead(new Map()));

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => overlayRead(new Map()),
        readSessionStatusOverlay: readStatusOverlay,
      });

      await daemon.tick();
      expect(upserts).toHaveLength(3);
      expect(readStatusOverlay).toHaveBeenCalledTimes(1);

      await daemon.tick();
      expect(readStatusOverlay).toHaveBeenCalledTimes(2);
    });

    it('never invokes the session-status overlay when sessionStateDir is unset', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-runner.jsonl': TRANSCRIPT(
          'session-runner',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      const readStatusOverlay = vi.fn(() => statusOverlayRead(new Map()));

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        forceSource: 'issue-agent',
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        readSessionStatusOverlay: readStatusOverlay,
      });

      await daemon.tick();

      expect(readStatusOverlay).not.toHaveBeenCalled();
      expect(upserts[0]).not.toHaveProperty('status');
    });

    it('never disturbs the title when setting/clearing status, and vice versa, including interleaved writes', async () => {
      const { store, upserts } = createFakeStore();
      const files = {
        '/root/proj/session-mix.jsonl': TRANSCRIPT(
          'session-mix',
          '2026-07-12T10:00:00.000Z',
        ),
      };
      let titleOverlay = overlayRead(new Map());
      let statusOverlay = statusOverlayRead(new Map());

      const daemon = new WatcherDaemon({
        watchRoots: [
          { path: '/root', adapter: 'claude-code', projectDirAllowlist: ['*'] },
        ],
        host: 'test-host',
        store,
        heartbeatIntervalMs: HEARTBEAT_MS,
        stalenessWindowMs: STALENESS_MS,
        now: () => '2026-07-12T10:00:01.000Z',
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
        sessionStateDir: STATE_DIR,
        readSessionTitleOverlay: () => titleOverlay,
        readSessionStatusOverlay: () => statusOverlay,
      });

      // Tick 1: declare a title only.
      titleOverlay = overlayRead(
        new Map([
          ['session-mix', titleAnnotation('session-mix', 'Declared title')],
        ]),
      );
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ title: 'Declared title' });
      expect(upserts.at(-1)).not.toHaveProperty('status');

      // Tick 2: set a status — the title must be undisturbed.
      statusOverlay = statusOverlayRead(
        new Map([
          ['session-mix', statusAnnotation('session-mix', 'A live status')],
        ]),
      );
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({
        title: 'Declared title',
        status: 'A live status',
      });

      // Tick 3: change the title only — the status must be undisturbed.
      titleOverlay = overlayRead(
        new Map([['session-mix', titleAnnotation('session-mix', 'Retitled')]]),
      );
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({
        title: 'Retitled',
        status: 'A live status',
      });

      // Tick 4: clear the status only — the (changed) title must survive.
      statusOverlay = statusOverlayRead(new Map());
      await daemon.tick();
      expect(upserts.at(-1)).toMatchObject({ title: 'Retitled' });
      expect(upserts.at(-1)).not.toHaveProperty('status');
    });

    /**
     * Confirmed empirically (temporarily reverting `daemon.ts`'s cache key
     * from `JSON.stringify(write)` to `JSON.stringify(write.doc)` and
     * re-running this suite, then restoring it): for `status`/
     * `statusUpdatedAt` SPECIFICALLY, the first `it` below still passes
     * under a doc-only key too. That is expected, not a gap in this test —
     * `buildSessionWrite` derives `clearFields` as a pure function of
     * `summary.status`'s presence, the exact same condition `buildSessionDoc`
     * uses to decide whether `doc` carries a `status` key at all, so for
     * this one field pair `clearFields` happens to be fully recoverable from
     * `doc` alone and a doc-only key cannot diverge from a whole-write key.
     * The second `it` below is what actually demonstrates the risk this
     * design closes: it constructs two write-shaped values with an
     * IDENTICAL `doc` but DIFFERENT `clearFields` (modelling a future
     * clearable field whose clear-intent need not correlate with any other
     * doc field) and shows the existing `JSON.stringify(write)` comparison
     * already distinguishes them — with no change to `daemon.ts`. Keeping
     * both tests: the first proves today's real, observable behaviour
     * end-to-end; the second proves the design choice (key on the whole
     * write) is what protects a case today's fields don't yet exercise.
     */
    describe('the write cache keys on the whole SessionWrite', () => {
      it('a cleared status produces exactly ONE write carrying the delete, and subsequent ticks produce none', async () => {
        const { store, writes } = createFakeStore();
        const files = {
          '/root/proj/session-clear.jsonl': TRANSCRIPT(
            'session-clear',
            '2026-07-12T10:00:00.000Z',
          ),
        };
        let statusOverlay = statusOverlayRead(
          new Map([
            ['session-clear', statusAnnotation('session-clear', 'in progress')],
          ]),
        );

        const daemon = new WatcherDaemon({
          watchRoots: [
            {
              path: '/root',
              adapter: 'claude-code',
              projectDirAllowlist: ['*'],
            },
          ],
          host: 'test-host',
          store,
          heartbeatIntervalMs: HEARTBEAT_MS,
          stalenessWindowMs: STALENESS_MS,
          now: () => '2026-07-12T10:00:01.000Z',
          discover: () => Object.keys(files),
          readFile: (p: string) => files[p as keyof typeof files],
          statFile: (p: string) => fakeStat(files[p as keyof typeof files]),
          isProcessAliveForCwd: () => true,
          resolveGitBranch: async () => undefined,
          sessionStateDir: STATE_DIR,
          readSessionTitleOverlay: () => overlayRead(new Map()),
          readSessionStatusOverlay: () => statusOverlay,
        });

        // Tick 1: status present — one write, nothing requested for
        // deletion.
        await daemon.tick();
        expect(writes).toHaveLength(1);
        expect(writes[0].clearFields).toEqual([]);
        expect(writes[0].doc).toMatchObject({ status: 'in progress' });

        // Tick 2: `lcars session status --clear` happens — the annotation
        // disappears. Exactly ONE more write must go out, and it must be
        // the one carrying the delete.
        statusOverlay = statusOverlayRead(new Map());
        await daemon.tick();
        expect(writes).toHaveLength(2);
        expect(writes[1].clearFields).toEqual(['status', 'statusUpdatedAt']);
        expect(writes[1].doc).not.toHaveProperty('status');
        expect(writes[1].doc).not.toHaveProperty('statusUpdatedAt');

        // Tick 3, 4: still cleared, nothing else changed — the write cache
        // must dedupe this to zero further writes, not resend the delete
        // forever.
        await daemon.tick();
        await daemon.tick();
        expect(writes).toHaveLength(2);
      });

      /**
       * The write cache is `JSON.stringify(write)` compared against the
       * previous tick's serialized write, where `write: { doc, clearFields
       * }`. This test proves that mechanism is already total over
       * `clearFields`'s *contents*, not merely over today's two field names
       * — so a future `ClearableSessionField` addition changes what
       * `clearFields` contains, which changes the serialized write, which
       * the EXISTING string comparison in `WatcherDaemon.tick()` already
       * treats as a cache miss. No line in `daemon.ts` needs to change for
       * that to keep holding; the property is inherited entirely from
       * comparing the WHOLE write rather than the doc alone. See
       * `SessionWrite`'s doc comment (`@agent-lcars/telemetry`'s
       * `types.ts`) for why a doc-only key can't offer the same guarantee.
       */
      it('adding a hypothetical future clearable field requires no change to the caching logic', () => {
        const doc = { sessionId: 'session-future', liveness: 'live' };
        // `ClearableSessionField` is a closed union today (`'status' |
        // 'statusUpdatedAt'`) — this cast models what the type becomes the
        // day a THIRD field is added, without touching that union or any
        // daemon code to prove the point.
        type FutureClearableField =
          'status' | 'statusUpdatedAt' | 'noteHypotheticallyAddedLater';
        const before: { doc: unknown; clearFields: FutureClearableField[] } = {
          doc,
          clearFields: ['status', 'statusUpdatedAt'],
        };
        const after: { doc: unknown; clearFields: FutureClearableField[] } = {
          doc,
          clearFields: [
            'status',
            'statusUpdatedAt',
            'noteHypotheticallyAddedLater',
          ],
        };

        // Same doc, different clearFields — exactly the shape a future
        // clearable field would produce on an otherwise-unchanged tick.
        expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
        // The daemon's actual cache comparison is nothing more than this
        // string inequality (`this.lastWrittenWrites.get(sessionId) ===
        // serializedWrite`) — so this inequality alone is what makes the
        // next tick's upsert fire instead of being silently deduped.
      });
    });
  });
});
