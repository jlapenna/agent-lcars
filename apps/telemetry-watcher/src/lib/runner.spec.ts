import { SessionDoc, SessionWrite } from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startSidecar } from './runner';
import { RunnerConfig } from './runner-config';
import { executeSessionTitleAnnotationCommand } from './session-title-annotation-command';
import { SESSION_STATE_DIRECTORY } from './session-title-paths';
import { SessionStore } from './store';

/** A provider transcript shaped like the QueueExecutor sidecar captures.
 * `startSidecar` supplies its authoritative `source: 'issue-agent'`
 * context rather than relying on provider-specific transcript metadata. */
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

/** A Codex CLI rollout transcript, mirroring the shape
 * `libs/telemetry/src/lib/fixtures/codex-session.jsonl` uses. Note it
 * carries no issue-agent marker of any kind — Codex has no equivalent of
 * Claude's `entrypoint` field, which is exactly why runner mode forces the
 * source rather than trusting the transcript (see
 * `BuildSessionDocOptions.forceSource`). */
const CODEX_TRANSCRIPT = [
  JSON.stringify({
    timestamp: '2026-07-27T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: 'codex-runner-session',
      cwd: '/home/runner/_work/agent-lcars/agent-lcars',
      model: 'gpt-5.6',
      approval_policy: 'on-request',
      instructions: 'Port the queue runtime',
    },
  }),
  JSON.stringify({
    timestamp: '2026-07-27T10:00:05.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 120,
          cached_input_tokens: 40,
          output_tokens: 30,
        },
      },
    },
  }),
].join('\n');

const OPENCODE_TRANSCRIPT = JSON.stringify({
  info: {
    id: 'ses_opencode_runner',
    directory: '/home/runner/_work/agent-lcars/agent-lcars',
    time: { created: 1787052570554, updated: 1787052721363 },
  },
  messages: [
    {
      info: {
        role: 'user',
        time: { created: 1787052570573 },
      },
      parts: [],
    },
    {
      info: {
        role: 'assistant',
        providerID: 'homelab',
        modelID: 'default',
        time: { created: 1787052570596, completed: 1787052721352 },
        tokens: {
          input: 20,
          output: 7,
          cache: { read: 40, write: 0 },
        },
      },
      parts: [],
    },
  ],
});

function createFakeStore() {
  const upserts: SessionDoc[] = [];
  const store: SessionStore = {
    async upsertSession(write: SessionWrite) {
      upserts.push(write.doc);
    },
  };
  return { store, upserts };
}

/** No test below that doesn't explicitly exercise the overlay (see the
 * "session-status overlay (issue #1289)" describe block) writes anything
 * here, so every other test in this file doubles as a regression guard on
 * the required acceptance criterion that runner mode behaves identically
 * to before #1289 when no overlay exists: `readSessionStatusOverlay`'s real
 * `fs` implementation hits a real ENOENT against this path and reports
 * `available: false`, the same fail-soft outcome as `sessionStateDir` being
 * unset entirely (see session-title-annotation-source.ts). */
const NO_OVERLAY_STATE_DIR = '/nonexistent/agent-lcars-session-state-fixture';

function baseConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    claudeProjectsDir: '/home/runner/.claude/projects',
    codexSessionsDir: '/home/runner/.codex/sessions',
    opencodeExportsDir: '/tmp/agent-lcars-opencode-exports',
    opencodeWorkspaceDir: '/home/runner/_work/agent-lcars/agent-lcars',
    sessionStateDir: NO_OVERLAY_STATE_DIR,
    host: 'runner-host',
    heartbeatIntervalMs: 10_000,
    stalenessWindowMs: 50_000,
    ...overrides,
  };
}

describe('startSidecar', () => {
  it('tags upserted docs with the configured runId and issueNumber', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/home/runner/.claude/projects/proj/session-a.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-a', '2026-07-19T10:00:00.000Z'),
    };

    const daemon = startSidecar({
      config: baseConfig({
        runId: '999888777',
        intentId: 'octo/example#3107/r1',
        issueNumber: 3107,
      }),
      store,
      autoStart: false,
      now: () => '2026-07-19T10:00:01.000Z',
      discover: (rootPath: string) =>
        Object.keys(files).filter((f) => f.startsWith(rootPath)),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      source: 'issue-agent',
      runId: '999888777',
      intentId: 'octo/example#3107/r1',
      issueNumber: 3107,
    });
  });

  it('tags upserted docs with the configured repo', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/home/runner/.claude/projects/proj/session-repo.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-repo', '2026-07-19T10:00:00.000Z'),
    };

    const daemon = startSidecar({
      config: baseConfig({
        repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
      }),
      store,
      autoStart: false,
      now: () => '2026-07-19T10:00:01.000Z',
      discover: (rootPath: string) =>
        Object.keys(files).filter((f) => f.startsWith(rootPath)),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
    });

    await daemon.tick();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      source: 'issue-agent',
      repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    });
  });

  it('omits runId/issueNumber from the doc when the config has neither', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/home/runner/.claude/projects/proj/session-b.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-b', '2026-07-19T10:00:00.000Z'),
    };

    const daemon = startSidecar({
      config: baseConfig(),
      store,
      autoStart: false,
      now: () => '2026-07-19T10:00:01.000Z',
      discover: (rootPath: string) =>
        Object.keys(files).filter((f) => f.startsWith(rootPath)),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();

    expect(upserts[0]).not.toHaveProperty('runId');
    expect(upserts[0]).not.toHaveProperty('issueNumber');
  });

  it('discovers transcripts with no allowlist restriction (any project dir matches)', async () => {
    const { store, upserts } = createFakeStore();
    let seenAllowlist: string[] | undefined;
    const files = {
      '/home/runner/.claude/projects/some-unrelated-dir-name/session-c.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-c', '2026-07-19T10:00:00.000Z'),
    };

    const daemon = startSidecar({
      config: baseConfig({ runId: '1' }),
      store,
      autoStart: false,
      now: () => '2026-07-19T10:00:01.000Z',
      discover: (rootPath, allowlist) => {
        // Only the Claude root's allowlist: the Codex root declares its own
        // `cwdAllowlist` (see runnerWatchRoots in @agent-lcars/telemetry),
        // asserted separately below.
        if (rootPath.includes('.claude')) seenAllowlist = allowlist;
        return Object.keys(files).filter((f) => f.startsWith(rootPath));
      },
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();

    expect(seenAllowlist).toEqual(['*']);
    expect(upserts).toHaveLength(1);
  });

  // Every QueueExecutor sidecar watches all supported provider roots, so a
  // provider session ships telemetry without a provider-specific path.
  it('discovers Codex transcripts under the Codex sessions root', async () => {
    const { store, upserts } = createFakeStore();
    const codexFile =
      '/home/runner/.codex/sessions/2026/07/27/rollout-abc.jsonl';
    const files = { [codexFile]: CODEX_TRANSCRIPT };

    const daemon = startSidecar({
      config: baseConfig({ runId: '5150', issueNumber: 47 }),
      store,
      autoStart: false,
      now: () => '2026-07-27T10:00:01.000Z',
      discover: (rootPath: string) =>
        Object.keys(files).filter((f) => f.startsWith(rootPath)),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sessionId: 'codex-runner-session',
      agent: 'codex',
      runId: '5150',
      issueNumber: 47,
      // The whole point of watching this root: real token counts.
      tokens: {
        inputTokens: 80,
        outputTokens: 30,
        cacheCreationTokens: 0,
        cacheReadTokens: 40,
      },
    });
  });

  it('does not scope Codex sessions to the host watcher checkout glob', async () => {
    const { store, upserts } = createFakeStore();
    let codexAllowlist: string[] | undefined;
    const codexFile =
      '/home/runner/.codex/sessions/2026/07/27/rollout-abc.jsonl';
    const files = { [codexFile]: CODEX_TRANSCRIPT };

    const daemon = startSidecar({
      config: baseConfig({ runId: '5150' }),
      store,
      autoStart: false,
      now: () => '2026-07-27T10:00:01.000Z',
      discover: (rootPath: string, allowlist: string[]) => {
        if (rootPath.includes('.codex')) codexAllowlist = allowlist;
        return Object.keys(files).filter((f) => f.startsWith(rootPath));
      },
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
    });

    await daemon.tick();

    // A runner checkout lives at /home/runner/_work/..., which would never
    // match the host default of `/home/developer/p/members*`.
    expect(codexAllowlist).toEqual(['*']);
    expect(upserts).toHaveLength(1);
  });

  it('captures and discovers OpenCode exports during a live runner tick', async () => {
    const { store, upserts } = createFakeStore();
    const opencodeFile =
      '/tmp/agent-lcars-opencode-exports/sessions/ses_opencode_runner.jsonl';
    const files = { [opencodeFile]: OPENCODE_TRANSCRIPT };
    const captureCalls: Array<{ workspaceDir: string; exportsDir: string }> =
      [];

    const daemon = startSidecar({
      config: baseConfig({ runId: '6160', issueNumber: 1502 }),
      store,
      autoStart: false,
      now: () => '2026-08-18T11:32:02.000Z',
      captureOpenCodeExports: (options) => {
        captureCalls.push(options);
        return { status: 'ok', selected: 1, exported: 1, failed: 0 };
      },
      discover: (rootPath: string) =>
        Object.keys(files).filter((file) => file.startsWith(rootPath)),
      readFile: (file) => files[file as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: OPENCODE_TRANSCRIPT.length }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
    });

    await daemon.tick();

    expect(captureCalls).toEqual([
      {
        workspaceDir: '/home/runner/_work/agent-lcars/agent-lcars',
        exportsDir: '/tmp/agent-lcars-opencode-exports',
      },
    ]);
    expect(upserts).toEqual([
      expect.objectContaining({
        sessionId: 'ses_opencode_runner',
        source: 'issue-agent',
        agent: 'opencode',
        runId: '6160',
        issueNumber: 1502,
        tokens: {
          inputTokens: 20,
          outputTokens: 7,
          cacheCreationTokens: 0,
          cacheReadTokens: 40,
        },
      }),
    ]);
  });

  it('retries OpenCode capture when the CLI becomes available after the initial tick', async () => {
    const { store } = createFakeStore();
    let captureCalls = 0;
    const daemon = startSidecar({
      config: baseConfig(),
      store,
      autoStart: false,
      captureOpenCodeExports: () => {
        captureCalls++;
        return captureCalls === 1
          ? {
              status: 'cli-unavailable',
              selected: 0,
              exported: 0,
              failed: 0,
            }
          : { status: 'ok', selected: 0, exported: 0, failed: 0 };
      },
      discover: () => [],
    });

    await daemon.tick();
    await daemon.tick();

    expect(captureCalls).toBe(2);
  });

  it('keeps OpenCode capture and discovery single-flight across overlapping ticks', async () => {
    const { store } = createFakeStore();
    let releaseCapture: (() => void) | undefined;
    let reportCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => {
      reportCaptureStarted = resolve;
    });
    const captureBlocked = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let captureCalls = 0;
    let discoverCalls = 0;
    const daemon = startSidecar({
      config: baseConfig(),
      store,
      autoStart: false,
      captureOpenCodeExports: async () => {
        captureCalls++;
        reportCaptureStarted?.();
        await captureBlocked;
        return { status: 'ok', selected: 0, exported: 0, failed: 0 };
      },
      discover: () => {
        discoverCalls++;
        return [];
      },
    });

    const firstTick = daemon.tick();
    await captureStarted;
    const overlappingTick = daemon.tick();

    expect(overlappingTick).toBe(firstTick);
    expect(captureCalls).toBe(1);
    expect(discoverCalls).toBe(0);

    releaseCapture?.();
    await Promise.all([firstTick, overlappingTick]);
    expect(discoverCalls).toBe(3);

    await daemon.tick();
    expect(captureCalls).toBe(2);
    expect(discoverCalls).toBe(6);
  });

  it('does not start the daemon interval when autoStart is false', async () => {
    const { store } = createFakeStore();

    const daemon = startSidecar({
      config: baseConfig(),
      store,
      autoStart: false,
      discover: () => [],
    });

    // stop() on a daemon that never started must be a no-op, not a throw.
    expect(() => daemon.stop()).not.toThrow();
  });

  /**
   * Issue #1289: `startSidecar` now threads `config.sessionStateDir` into
   * `WatcherDaemon`, so `tick()` reads the same session-title/status
   * overlay a host watcher does. These tests deliberately inject no
   * `readSessionTitleOverlay`/`readSessionStatusOverlay` seam — they write
   * through the REAL CLI command (`executeSessionTitleAnnotationCommand`,
   * the exact function `lcars-session-title.cjs` calls) into a real temp
   * directory, and let the daemon read it back with the real `fs`-backed
   * reader. Mocked seams here would only prove the plumbing accepts a
   * value, not that a dispatched agent's actual `lcars session
   * status "..."` invocation reaches the doc — which is the one thing
   * #1289 exists to fix.
   */
  describe('session-title/status overlay (issue #1289)', () => {
    let homeDirectory: string;
    let stateDirectory: string;

    beforeEach(() => {
      homeDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'lcars-runner-overlay-'),
      );
      stateDirectory = path.join(homeDirectory, SESSION_STATE_DIRECTORY);
    });

    afterEach(() => {
      fs.rmSync(homeDirectory, { recursive: true, force: true });
    });

    it('joins a declared status written by the real CLI into the built SessionWrite', async () => {
      const { store, upserts } = createFakeStore();
      const sessionId = 'session-status-live';
      const files = {
        [`/home/runner/.claude/projects/proj/${sessionId}.jsonl`]:
          ISSUE_AGENT_TRANSCRIPT(sessionId, '2026-07-19T10:00:00.000Z'),
      };

      const written = executeSessionTitleAnnotationCommand(
        ['session', 'status', 'Running the test suite'],
        { homeDirectory, env: { CLAUDE_CODE_SESSION_ID: sessionId } },
      );
      expect(written.ok).toBe(true);

      const daemon = startSidecar({
        config: baseConfig({ sessionStateDir: stateDirectory }),
        store,
        autoStart: false,
        now: () => '2026-07-19T10:00:01.000Z',
        discover: (rootPath: string) =>
          Object.keys(files).filter((f) => f.startsWith(rootPath)),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: () => ({ mtimeMs: 1, size: 10 }),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
      });

      await daemon.tick();

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        sessionId,
        status: 'Running the test suite',
      });
      expect(upserts[0].statusUpdatedAt).toBeTruthy();
    });

    it('joins a declared title the same way, alongside status', async () => {
      const { store, upserts } = createFakeStore();
      const sessionId = 'session-title-live';
      const files = {
        [`/home/runner/.claude/projects/proj/${sessionId}.jsonl`]:
          ISSUE_AGENT_TRANSCRIPT(sessionId, '2026-07-19T10:00:00.000Z'),
      };

      executeSessionTitleAnnotationCommand(
        ['session', 'title', 'Port the CLI into the runner image'],
        { homeDirectory, env: { CLAUDE_CODE_SESSION_ID: sessionId } },
      );

      const daemon = startSidecar({
        config: baseConfig({ sessionStateDir: stateDirectory }),
        store,
        autoStart: false,
        now: () => '2026-07-19T10:00:01.000Z',
        discover: (rootPath: string) =>
          Object.keys(files).filter((f) => f.startsWith(rootPath)),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: () => ({ mtimeMs: 1, size: 10 }),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
      });

      await daemon.tick();

      expect(upserts[0]).toMatchObject({
        sessionId,
        title: 'Port the CLI into the runner image',
      });
    });

    it('is fail-soft when sessionStateDir points at a directory that was never written to', async () => {
      const { store, upserts } = createFakeStore();
      const sessionId = 'session-status-missing-dir';
      const files = {
        [`/home/runner/.claude/projects/proj/${sessionId}.jsonl`]:
          ISSUE_AGENT_TRANSCRIPT(sessionId, '2026-07-19T10:00:00.000Z'),
      };

      const daemon = startSidecar({
        // stateDirectory exists as a path string but nothing was ever
        // written beneath it (homeDirectory is a real, empty temp dir) --
        // the same shape as a genuine runner container whose agent never
        // ran `lcars session status`.
        config: baseConfig({ sessionStateDir: stateDirectory }),
        store,
        autoStart: false,
        now: () => '2026-07-19T10:00:01.000Z',
        discover: (rootPath: string) =>
          Object.keys(files).filter((f) => f.startsWith(rootPath)),
        readFile: (p: string) => files[p as keyof typeof files],
        statFile: () => ({ mtimeMs: 1, size: 10 }),
        isProcessAliveForCwd: () => true,
        resolveGitBranch: async () => undefined,
      });

      await expect(daemon.tick()).resolves.toBeUndefined();

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).not.toHaveProperty('status');
    });
  });
});
