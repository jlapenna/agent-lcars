import { SessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import { startRideAlong } from './runner';
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
    host: 'runner-host',
    heartbeatIntervalMs: 10_000,
    stalenessWindowMs: 50_000,
    ...overrides,
  };
}

describe('startRideAlong', () => {
  it('tags upserted docs with the configured runId and issueNumber', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/home/runner/.claude/projects/proj/session-a.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-a', '2026-07-19T10:00:00.000Z'),
    };

    const daemon = startRideAlong({
      config: baseConfig({ runId: '999888777', issueNumber: 3107 }),
      store,
      autoStart: false,
      now: () => '2026-07-19T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: () => undefined,
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

    const daemon = startRideAlong({
      config: baseConfig({
        repo: { owner: 'supersprinklesracing', name: 'members' },
      }),
      store,
      autoStart: false,
      now: () => '2026-07-19T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: () => undefined,
      resolveGitRepo: () => undefined,
    });

    await daemon.tick();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      source: 'issue-agent',
      repo: { owner: 'supersprinklesracing', name: 'members' },
    });
  });

  it('omits runId/issueNumber from the doc when the config has neither', async () => {
    const { store, upserts } = createFakeStore();
    const files = {
      '/home/runner/.claude/projects/proj/session-b.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-b', '2026-07-19T10:00:00.000Z'),
    };

    const daemon = startRideAlong({
      config: baseConfig(),
      store,
      autoStart: false,
      now: () => '2026-07-19T10:00:01.000Z',
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: () => undefined,
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

    const daemon = startRideAlong({
      config: baseConfig({ runId: '1' }),
      store,
      autoStart: false,
      now: () => '2026-07-19T10:00:01.000Z',
      discover: (_dir, allowlist) => {
        seenAllowlist = allowlist;
        return Object.keys(files);
      },
      readFile: (p: string) => files[p as keyof typeof files],
      statFile: () => ({ mtimeMs: 1, size: 10 }),
      isProcessAliveForCwd: () => true,
      resolveGitBranch: () => undefined,
    });

    await daemon.tick();

    expect(seenAllowlist).toEqual(['*']);
    expect(upserts).toHaveLength(1);
  });

  it('does not start the daemon interval when autoStart is false', async () => {
    const { store } = createFakeStore();

    const daemon = startRideAlong({
      config: baseConfig(),
      store,
      autoStart: false,
      discover: () => [],
    });

    // stop() on a daemon that never started must be a no-op, not a throw.
    expect(() => daemon.stop()).not.toThrow();
  });
});
