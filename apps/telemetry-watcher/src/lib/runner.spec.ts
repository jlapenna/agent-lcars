import { SessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import { startSidecar } from './runner';
import { RunnerConfig } from './runner-config';
import { SessionStore } from './store';

/** An issue-agent-shaped transcript: the `entrypoint:
 * 'claude-code-github-action'` marker on the first user line is what the
 * reducer keys off of to tag `source: 'issue-agent'` (see
 * libs/telemetry/src/lib/reducer.ts and the
 * session-with-result.jsonl fixture this mirrors) — a plain CLI-shaped
 * transcript would reduce to `source: 'cli'`, and `runId`/`issueNumber`
 * are dropped entirely for that source (see buildSessionDoc). */
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
      instructions: 'Port codex.yml',
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

function createFakeStore() {
  const upserts: SessionDoc[] = [];
  const store: SessionStore = {
    async upsertSession(doc: SessionDoc) {
      upserts.push(doc);
    },
  };
  return { store, upserts };
}

function baseConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    claudeProjectsDir: '/home/runner/.claude/projects',
    codexSessionsDir: '/home/runner/.codex/sessions',
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
      config: baseConfig({ runId: '999888777', issueNumber: 3107 }),
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

  // Until codex.yml existed the sidecar declared only the Claude root, so a
  // Codex run shipped no telemetry at all — no turns, no tokens, no session
  // row in the console. These pin both halves of the fix.
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
});
