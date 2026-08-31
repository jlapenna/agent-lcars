import { SessionDoc, SessionWrite } from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { finalizeSidecar } from './finalize';
import { captureOpenCodeExports } from './opencode-export-capture';
import { RunnerConfig } from './runner-config';
import { SessionStore } from './store';
import { UploadTranscriptOptions } from './transcript-upload';

/** A Codex CLI rollout transcript, mirroring runner.spec.ts's own
 * CODEX_TRANSCRIPT fixture (kept separate rather than shared/exported since
 * both files' copies are meant to stay simple, self-contained JSONL
 * literals, not indirection through a shared builder). */
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

/** Same fixture shape as runner.spec.ts's ISSUE_AGENT_TRANSCRIPT. The
 * QueueExecutor finalizer supplies `source: 'issue-agent'`. */
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

function createFakeStore() {
  const upserts: SessionDoc[] = [];
  const store: SessionStore = {
    async upsertSession(write: SessionWrite) {
      upserts.push(write.doc);
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

/** Mirrors runner.spec.ts's own constant of the same name/purpose — see its
 * doc comment. Every test below that doesn't explicitly exercise the
 * status overlay (the "session-status overlay (issue #1289)" describe
 * block) doubles as a regression guard that finalize behaves identically
 * to before #1289 when no overlay exists. */
const NO_OVERLAY_STATE_DIR = '/nonexistent/agent-lcars-session-state-fixture';

function baseConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    repo: { owner: 'jlapenna', name: 'agent-lcars' },
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

describe('finalizeSidecar', () => {
  it('ships a doc with liveness ended, regardless of process/heartbeat state', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript } = createFakeUploader();
    const files = {
      '/home/runner/.claude/projects/proj/session-a.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-a', '2026-07-19T10:00:00.000Z'),
    };

    await finalizeSidecar({
      config: baseConfig({
        runId: '999888777',
        intentId: 'octo/example#3107/r1',
        issueNumber: 3107,
      }),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
      uploadTranscript,
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      source: 'issue-agent',
      liveness: 'ended',
      runId: '999888777',
      intentId: 'octo/example#3107/r1',
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

    await finalizeSidecar({
      config: baseConfig({
        runId: '42',
        transcriptsBucket: 'agent-lcars-session-transcripts',
      }),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
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

  it('archives a Codex transcript under the codex/ prefix, not claude-code/ (Bug 1, #645)', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript, uploads } = createFakeUploader();
    const codexFile =
      '/home/runner/.codex/sessions/2026/07/27/rollout-abc.jsonl';
    const files = { [codexFile]: CODEX_TRANSCRIPT };

    await finalizeSidecar({
      config: baseConfig({
        runId: '42',
        transcriptsBucket: 'agent-lcars-session-transcripts',
      }),
      store,
      // Root-scoped (like runner.spec.ts's Codex tests) rather than
      // `() => Object.keys(files)`: this file must only surface under the
      // Codex root, not also get (harmlessly, but confusingly) tried
      // against the Claude root's adapter.
      discover: (rootPath: string) =>
        Object.keys(files).filter((f) => f.startsWith(rootPath)),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
      uploadTranscript,
    });

    expect(uploads).toEqual([
      {
        projectId: undefined,
        bucket: 'agent-lcars-session-transcripts',
        object: 'runs/42/codex/codex-runner-session.jsonl',
        contents: CODEX_TRANSCRIPT,
      },
    ]);
    expect(upserts[0]).toMatchObject({
      agent: 'codex',
      renderable: true,
      transcriptGcsUri:
        'gs://agent-lcars-session-transcripts/runs/42/codex/codex-runner-session.jsonl',
    });
  });

  it('archives only the strict OpenCode metadata allowlist under the opencode prefix', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript, uploads } = createFakeUploader();
    const exportsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opencode-finalize-test-'),
    );
    try {
      await captureOpenCodeExports({
        workspaceDir: '/home/runner/_work/agent-lcars/agent-lcars',
        exportsDir,
        runOpenCode: () =>
          JSON.stringify([
            {
              id: 'ses_opencode_final',
              directory: '/home/runner/_work/agent-lcars/agent-lcars',
            },
          ]),
        runOpenCodeToFile: (_args, output) => {
          fs.writeFileSync(
            output,
            JSON.stringify({
              info: {
                id: 'ses_opencode_final',
                time: { created: 1787052570554, updated: 1787052721363 },
                metadata: { credential: 'writer-secret-gcs' },
                share: { url: 'writer-secret-share' },
                permission: { bash: 'allow' },
              },
              messages: [
                {
                  info: { role: 'user', time: { created: 1787052570573 } },
                  parts: [{ type: 'text', text: 'writer-secret-message' }],
                },
              ],
            }),
          );
        },
      });

      await finalizeSidecar({
        config: baseConfig({
          runId: '42',
          transcriptsBucket: 'agent-lcars-session-transcripts',
          opencodeExportsDir: exportsDir,
        }),
        store,
        captureOpenCodeExports: () => ({
          status: 'ok',
          selected: 1,
          exported: 1,
          failed: 0,
        }),
        resolveGitBranch: async () => undefined,
        resolveGitRepo: async () => undefined,
        uploadTranscript,
      });
    } finally {
      fs.rmSync(exportsDir, { recursive: true, force: true });
    }

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      projectId: undefined,
      bucket: 'agent-lcars-session-transcripts',
      object: 'runs/42/opencode/ses_opencode_final.jsonl',
    });
    expect(uploads[0]?.contents).not.toContain('writer-secret');
    expect(JSON.parse(uploads[0]?.contents ?? '')).toEqual({
      info: {
        id: 'ses_opencode_final',
        directory: '/home/runner/_work/agent-lcars/agent-lcars',
        time: { created: 1787052570554, updated: 1787052721363 },
      },
      messages: [
        {
          info: { role: 'user', time: { created: 1787052570573 } },
          parts: [],
        },
      ],
    });
    expect(upserts).toEqual([
      expect.objectContaining({
        sessionId: 'ses_opencode_final',
        agent: 'opencode',
        renderable: false,
        transcriptGcsUri:
          'gs://agent-lcars-session-transcripts/runs/42/opencode/ses_opencode_final.jsonl',
      }),
    ]);
  });

  it('reports a zero-session finalize pass loudly instead of shipping nothing silently (Bug 2, #645)', async () => {
    const { store, upserts } = createFakeStore();
    const consoleLogSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const originalGithubActions = process.env['GITHUB_ACTIONS'];

    try {
      process.env['GITHUB_ACTIONS'] = 'true';
      await finalizeSidecar({
        config: baseConfig({ runId: '777' }),
        store,
        discover: () => [],
      });

      expect(upserts).toHaveLength(0);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^::warning::.*zero sessions.*777/),
      );
    } finally {
      consoleLogSpy.mockRestore();
      if (originalGithubActions === undefined) {
        delete process.env['GITHUB_ACTIONS'];
      } else {
        process.env['GITHUB_ACTIONS'] = originalGithubActions;
      }
    }
  });

  it('does not warn about a zero-session pass when at least one session shipped', async () => {
    const { store } = createFakeStore();
    const { uploadTranscript } = createFakeUploader();
    const consoleLogSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const originalGithubActions = process.env['GITHUB_ACTIONS'];
    const files = {
      '/home/runner/.claude/projects/proj/session-g.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-g', '2026-07-19T10:00:00.000Z'),
    };

    try {
      process.env['GITHUB_ACTIONS'] = 'true';
      await finalizeSidecar({
        config: baseConfig(),
        store,
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        resolveGitBranch: async () => undefined,
        resolveGitRepo: async () => undefined,
        uploadTranscript,
      });

      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringMatching(/zero sessions/),
      );
    } finally {
      consoleLogSpy.mockRestore();
      if (originalGithubActions === undefined) {
        delete process.env['GITHUB_ACTIONS'];
      } else {
        process.env['GITHUB_ACTIONS'] = originalGithubActions;
      }
    }
  });

  it('ships the doc without transcriptGcsUri when no bucket is configured', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript, uploads } = createFakeUploader();
    const files = {
      '/home/runner/.claude/projects/proj/session-c.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-c', '2026-07-19T10:00:00.000Z'),
    };

    await finalizeSidecar({
      config: baseConfig(),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
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
      finalizeSidecar({
        config: baseConfig({
          transcriptsBucket: 'agent-lcars-session-transcripts',
        }),
        store,
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        resolveGitBranch: async () => undefined,
        resolveGitRepo: async () => undefined,
        uploadTranscript,
      }),
    ).resolves.toBeUndefined();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).not.toHaveProperty('transcriptGcsUri');
  });

  it('annotates a GitHub Actions ::warning:: when the upload fails and GITHUB_ACTIONS=true, but stays silent otherwise', async () => {
    const { store } = createFakeStore();
    const uploadTranscript = vi
      .fn()
      .mockRejectedValue(new Error('unauthorized_client'));
    const files = {
      '/home/runner/.claude/projects/proj/session-warn.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-warn', '2026-07-19T10:00:00.000Z'),
    };
    const consoleLogSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const originalGithubActions = process.env['GITHUB_ACTIONS'];

    try {
      delete process.env['GITHUB_ACTIONS'];
      await finalizeSidecar({
        config: baseConfig({
          transcriptsBucket: 'agent-lcars-session-transcripts',
        }),
        store,
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        resolveGitBranch: async () => undefined,
        resolveGitRepo: async () => undefined,
        uploadTranscript,
      });
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringMatching(/^::warning::/),
      );

      process.env['GITHUB_ACTIONS'] = 'true';
      await finalizeSidecar({
        config: baseConfig({
          transcriptsBucket: 'agent-lcars-session-transcripts',
        }),
        store,
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        resolveGitBranch: async () => undefined,
        resolveGitRepo: async () => undefined,
        uploadTranscript,
      });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^::warning::.*unauthorized_client/),
      );
    } finally {
      consoleLogSpy.mockRestore();
      if (originalGithubActions === undefined) {
        delete process.env['GITHUB_ACTIONS'];
      } else {
        process.env['GITHUB_ACTIONS'] = originalGithubActions;
      }
    }
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

    await finalizeSidecar({
      config: baseConfig(),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => {
        if (p.includes('broken')) {
          throw new Error('EACCES');
        }
        return files[p as keyof typeof files];
      },
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
      uploadTranscript,
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].sessionId).toBe('session-e');
  });

  it('continues shipping other sessions when the store rejects one upsert', async () => {
    const uploadTranscript = vi.fn(async () => undefined);
    const upserts: SessionDoc[] = [];
    const store: SessionStore = {
      async upsertSession(write: SessionWrite) {
        if (write.doc.sessionId === 'session-fail') {
          throw new Error('unavailable');
        }
        upserts.push(write.doc);
      },
    };
    const files = {
      '/home/runner/.claude/projects/proj/session-fail.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-fail', '2026-07-19T10:00:00.000Z'),
      '/home/runner/.claude/projects/proj/session-ok.jsonl':
        ISSUE_AGENT_TRANSCRIPT('session-ok', '2026-07-19T10:00:00.000Z'),
    };

    await expect(
      finalizeSidecar({
        config: baseConfig(),
        store,
        discover: () => Object.keys(files),
        readFile: (p: string) => files[p as keyof typeof files],
        resolveGitBranch: async () => undefined,
        resolveGitRepo: async () => undefined,
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

    await finalizeSidecar({
      config: baseConfig({
        repo: { owner: 'jlapenna', name: 'agent-lcars' },
      }),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
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

    await finalizeSidecar({
      config: baseConfig(),
      store,
      discover: (rootPath: string, allowlist: string[]) => {
        if (rootPath.includes('.claude')) seenAllowlist = allowlist;
        return Object.keys(files);
      },
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
      uploadTranscript,
    });

    expect(seenAllowlist).toEqual(['*']);
    expect(upserts).toHaveLength(1);
  });

  it('does nothing (no throw) when discovery finds no transcripts', async () => {
    const { store, upserts } = createFakeStore();

    await expect(
      finalizeSidecar({
        config: baseConfig(),
        store,
        discover: () => [],
      }),
    ).resolves.toBeUndefined();

    expect(upserts).toHaveLength(0);
  });

  it('applies explicit title and status annotations to the final write', async () => {
    const { store, upserts } = createFakeStore();
    const { uploadTranscript } = createFakeUploader();
    const sessionId = 'session-title-ended';
    const files = {
      [`/home/runner/.claude/projects/proj/${sessionId}.jsonl`]: [
        JSON.stringify({
          isSidechain: false,
          type: 'user',
          uuid: `${sessionId}-u1`,
          timestamp: '2026-07-19T10:00:00.000Z',
          sessionId,
          cwd: '/home/runner/work/members/members',
          aiTitle: 'Generated by the runtime',
          message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
        }),
      ].join('\n'),
    };

    const seenSessionIds: string[][] = [];
    await finalizeSidecar({
      config: baseConfig({ sessionStateDir: '/state' }),
      store,
      discover: () => Object.keys(files),
      readFile: (p: string) => files[p as keyof typeof files],
      resolveGitBranch: async () => undefined,
      resolveGitRepo: async () => undefined,
      uploadTranscript,
      readSessionStatusOverlay: (_stateDirectory, sessionIds) => {
        seenSessionIds.push([...sessionIds]);
        return {
          available: true,
          annotations: new Map([
            [
              sessionId,
              {
                version: 1,
                sessionId,
                updatedAt: '2026-07-19T10:01:00.000Z',
                status: 'Opened the PR',
              },
            ],
          ]),
        };
      },
      readSessionTitleOverlay: (_stateDirectory, sessionIds) => {
        seenSessionIds.push([...sessionIds]);
        return {
          declared: {
            available: true,
            annotations: new Map([
              [
                sessionId,
                {
                  version: 1,
                  sessionId,
                  updatedAt: '2026-07-19T10:01:00.000Z',
                  title: 'Declared by the agent',
                },
              ],
            ]),
          },
        };
      },
    });

    expect(seenSessionIds).toContainEqual([sessionId]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sessionId,
      liveness: 'ended',
      title: 'Declared by the agent',
      status: 'Opened the PR',
    });
  });
});
