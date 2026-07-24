import { SessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { finalizeRideAlong } from './finalize';
import { RunnerConfig } from './runner-config';
import { SessionStore } from './store';
import { UploadTranscriptOptions } from './transcript-upload';

/** Same fixture shape as runner.spec.ts's ISSUE_AGENT_TRANSCRIPT — the
 * `entrypoint: 'claude-code-github-action'` marker is what the reducer keys
 * off of to tag `source: 'issue-agent'`. */
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

function createFakeUploader() {
  const uploads: UploadTranscriptOptions[] = [];
  const uploadTranscript = vi.fn(async (options: UploadTranscriptOptions) => {
    uploads.push(options);
  });
  return { uploadTranscript, uploads };
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

describe('finalizeRideAlong', () => {
  it('ships a doc with liveness ended, regardless of process/heartbeat state', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript } = createFakeUploader();
    const files = {
      '/home/runner/.claude/projects/proj/session-a.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-a', '2026-07-19T10:00:00.000Z'),
    };

    await finalizeRideAlong({
      config: baseConfig({ runId: '999888777', issueNumber: 3107 }),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: () => undefined,
      resolveGitRepo: () => undefined,
      uploadTranscript,
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      source: 'issue-agent',
      liveness: 'ended',
      runId: '999888777',
      issueNumber: 3107,
    });
  });

  it('uploads the raw transcript and attaches transcriptGcsUri when a bucket is configured', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript, uploads } = createFakeUploader();
    const content = ISSUE_AGENT_TRANSCRIPT(
      'session-b',
      '2026-07-19T10:00:00.000Z',
    );
    const files = {
      '/home/runner/.claude/projects/proj/session-b.jsonl': content,
    };

    await finalizeRideAlong({
      config: baseConfig({
        runId: '42',
        transcriptsBucket: 'agent-lcars-session-transcripts',
      }),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: () => undefined,
      resolveGitRepo: () => undefined,
      uploadTranscript,
    });

    expect(uploads).toEqual([
      {
        projectId: undefined,
        bucket: 'agent-lcars-session-transcripts',
        object: 'runs/42/claude-code/session-b.jsonl',
        contents: content,
      },
    ]);
    expect(upserts[0]).toMatchObject({
      transcriptGcsUri:
        'gs://agent-lcars-session-transcripts/runs/42/claude-code/session-b.jsonl',
    });
  });

  it('ships the doc without transcriptGcsUri when no bucket is configured', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript, uploads } = createFakeUploader();
    const files = {
      '/home/runner/.claude/projects/proj/session-c.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-c', '2026-07-19T10:00:00.000Z'),
    };

    await finalizeRideAlong({
      config: baseConfig(),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: () => undefined,
      resolveGitRepo: () => undefined,
      uploadTranscript,
    });

    expect(uploads).toHaveLength(0);
    expect(upserts[0]).not.toHaveProperty('transcriptGcsUri');
  });

  it('ships the doc without transcriptGcsUri when the upload fails, rather than dropping it', async () => {
    const { store, upserts } = createFakeStore();
    const uploadTranscript = vi
      .fn()
      .mockRejectedValue(new Error('storage: permission denied'));
    const files = {
      '/home/runner/.claude/projects/proj/session-d.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-d', '2026-07-19T10:00:00.000Z'),
    };

    await expect(
      finalizeRideAlong({
        config: baseConfig({
          transcriptsBucket: 'agent-lcars-session-transcripts',
        }),
        store,
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        resolveGitBranch: () => undefined,
        resolveGitRepo: () => undefined,
        uploadTranscript,
      }),
    ).resolves.toBeUndefined();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).not.toHaveProperty('transcriptGcsUri');
  });

  it('skips a file it fails to read, without throwing or blocking other files', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript } = createFakeUploader();
    const files = {
      '/home/runner/.claude/projects/proj/broken.jsonl': ISSUE_AGENT_TRANSCRIPT(
        'broken',
        '2026-07-19T10:00:00.000Z',
      ),
      '/home/runner/.claude/projects/proj/session-e.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-e', '2026-07-19T10:00:00.000Z'),
    };

    await finalizeRideAlong({
      config: baseConfig(),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => {
        if (p.includes('broken')) {
          throw new Error('EACCES');
        }
        return files[p as keyof typeof files];
      },
      resolveGitBranch: () => undefined,
      resolveGitRepo: () => undefined,
      uploadTranscript,
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].sessionId).toBe('session-e');
  });

  it('continues shipping other sessions when the store rejects one upsert', async () => {
    const uploadTranscript = vi.fn(async () => undefined);
    const upserts: SessionDoc[] = [];
    const store: SessionStore = {
      async upsertSession(doc: SessionDoc) {
        if (doc.sessionId === 'session-fail') {
          throw new Error('unavailable');
        }
        upserts.push(doc);
      },
    };
    const files = {
      '/home/runner/.claude/projects/proj/session-fail.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-fail', '2026-07-19T10:00:00.000Z'),
      '/home/runner/.claude/projects/proj/session-ok.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-ok', '2026-07-19T10:00:00.000Z'),
    };

    await expect(
      finalizeRideAlong({
        config: baseConfig(),
        store,
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        resolveGitBranch: () => undefined,
        resolveGitRepo: () => undefined,
        uploadTranscript,
      }),
    ).resolves.toBeUndefined();

    expect(upserts.map((d) => d.sessionId)).toEqual(['session-ok']);
  });

  it('tags upserted docs with the configured repo', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript } = createFakeUploader();
    const files = {
      '/home/runner/.claude/projects/proj/session-repo.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-repo', '2026-07-19T10:00:00.000Z'),
    };

    await finalizeRideAlong({
      config: baseConfig({
        repo: { owner: 'jlapenna', name: 'agent-lcars' },
      }),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: () => undefined,
      resolveGitRepo: () => undefined,
      uploadTranscript,
    });

    expect(upserts[0]).toMatchObject({
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
    });
  });

  it('discovers transcripts with no allowlist restriction (any project dir matches)', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript } = createFakeUploader();
    let seenAllowlist: string[] | undefined;
    const files = {
      '/home/runner/.claude/projects/some-unrelated-dir-name/session-f.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-f', '2026-07-19T10:00:00.000Z'),
    };

    await finalizeRideAlong({
      config: baseConfig(),
      store,
      discover: (_dir: string, allowlist: string[]) => {
        seenAllowlist = allowlist;
        return Object.keys(files);
      },
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: () => undefined,
      resolveGitRepo: () => undefined,
      uploadTranscript,
    });

    expect(seenAllowlist).toEqual(['*']);
    expect(upserts).toHaveLength(1);
  });

  it('does nothing (no throw) when discovery finds no transcripts', async () => {
    const { store, upserts } = createFakeStore();

    await expect(
      finalizeRideAlong({
        config: baseConfig(),
        store,
        discover: () => [],
      }),
    ).resolves.toBeUndefined();

    expect(upserts).toHaveLength(0);
  });
});
