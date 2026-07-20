import { SessionDoc } from '@repo/agent-telemetry';
import { describe, expect, it, vi } from 'vitest';

import { WatcherDaemon } from './daemon';
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

function createFakeStore() {
  const upserts: SessionDoc[] = [];
  const store: SessionStore = {
    async upsertSession(doc: SessionDoc) {
      upserts.push(doc);
    },
  };
  return { store, upserts };
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
      resolveGitBranch: () => undefined,
    });

    await daemon.tick();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sessionId: 'session-a',
      liveness: 'live',
    });
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
      resolveGitBranch: () => undefined,
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
      resolveGitBranch: () => undefined,
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
      resolveGitBranch: () => undefined,
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
      resolveGitBranch: () => undefined,
    });

    await expect(daemon.tick()).resolves.toBeUndefined();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sessionId).toBe('session-good');
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
      resolveGitBranch: () => undefined,
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
      resolveGitBranch: () => undefined,
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
      resolveGitBranch: () => 'feature/fresh-branch',
    });

    await daemon.tick();

    expect(upserts[0]).toMatchObject({ branch: 'feature/fresh-branch' });
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
      resolveGitBranch: () => undefined,
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
      resolveGitBranch: () => undefined,
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
      resolveGitBranch: () => undefined,
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
      resolveGitBranch: () => undefined,
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
        resolveGitBranch: () => undefined,
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
        resolveGitBranch: () => undefined,
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
        resolveGitBranch: () => undefined,
      });

      await daemon.tick();

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({ sessionId: 'session-only' });
    });
  });
});
