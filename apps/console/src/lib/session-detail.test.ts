import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@agent-lcars/telemetry';
import { getSessionDoc } from '@agent-lcars/telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getSessionDetail } from './session-detail';
import { getSessionTranscript } from './session-transcript';

vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
  getSessionDoc: vi.fn(),
}));

vi.mock('./session-transcript', () => ({
  getSessionTranscript: vi.fn(),
}));

function cliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'cli-1',
    source: 'cli',
    liveness: 'ended',
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    turns: 3,
    toolCallCounts: {},
    tokens: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  };
}

function agentDoc(
  overrides: Partial<IssueAgentSessionDoc> = {},
): IssueAgentSessionDoc {
  return {
    sessionId: 'agent-1',
    source: 'issue-agent',
    liveness: 'ended',
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    turns: 6,
    toolCallCounts: {},
    tokens: {
      inputTokens: 1000,
      outputTokens: 400,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  };
}

describe('getSessionDetail', () => {
  afterEach(() => vi.resetAllMocks());

  it('returns not-found when the doc does not exist', async () => {
    (getSessionDoc as Mock).mockResolvedValue(undefined);

    const result = await getSessionDetail('missing');

    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns error with a warning when the store throws', async () => {
    (getSessionDoc as Mock).mockRejectedValue(new Error('boom'));

    const result = await getSessionDetail('any');

    expect(result.status).toBe('error');
    expect(result).toHaveProperty('warning');
  });

  it('returns the doc with no transcript for a CLI session', async () => {
    (getSessionDoc as Mock).mockResolvedValue(cliDoc());

    const result = await getSessionDetail('cli-1');

    expect(result.status).toBe('ok');
    expect(result).not.toHaveProperty('transcript');
    expect(getSessionTranscript).not.toHaveBeenCalled();
  });

  it('returns the doc with no transcript for an issue-agent session missing a transcriptGcsUri', async () => {
    (getSessionDoc as Mock).mockResolvedValue(
      agentDoc({ transcriptGcsUri: undefined }),
    );

    const result = await getSessionDetail('agent-1');

    expect(result.status).toBe('ok');
    expect(result).not.toHaveProperty('transcript');
    expect(getSessionTranscript).not.toHaveBeenCalled();
  });

  it('fetches and attaches the transcript for a claude-code issue-agent session that has one', async () => {
    (getSessionDoc as Mock).mockResolvedValue(
      agentDoc({
        agent: 'claude-code',
        transcriptGcsUri: 'gs://bucket/runs/1/a.jsonl',
      }),
    );
    (getSessionTranscript as Mock).mockResolvedValue({ events: [] });

    const result = await getSessionDetail('agent-1');

    expect(getSessionTranscript).toHaveBeenCalledWith(
      'gs://bucket/runs/1/a.jsonl',
    );
    expect(result.status).toBe('ok');
    expect(result).toMatchObject({ transcript: { events: [] } });
  });

  it('fetches the transcript for a legacy doc with no agent field (defaults to claude-code)', async () => {
    (getSessionDoc as Mock).mockResolvedValue(
      agentDoc({ transcriptGcsUri: 'gs://bucket/runs/1/a.jsonl' }),
    );
    (getSessionTranscript as Mock).mockResolvedValue({ events: [] });

    const result = await getSessionDetail('agent-1');

    expect(getSessionTranscript).toHaveBeenCalledWith(
      'gs://bucket/runs/1/a.jsonl',
    );
    expect(result.status).toBe('ok');
  });

  it('does not fetch a transcript for a non-claude-code agent even when transcriptGcsUri is set (#3123 phase 2)', async () => {
    (getSessionDoc as Mock).mockResolvedValue(
      agentDoc({
        agent: 'opencode',
        transcriptGcsUri:
          'gs://supersprinklesracing-agent-session-transcripts/runs/1/opencode/',
      }),
    );

    const result = await getSessionDetail('agent-1');

    expect(getSessionTranscript).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    expect(result).not.toHaveProperty('transcript');
    // The doc itself (and its transcriptGcsUri) still comes through for
    // the page to render its own archive-note fallback from.
    expect(result).toMatchObject({
      doc: {
        agent: 'opencode',
        transcriptGcsUri:
          'gs://supersprinklesracing-agent-session-transcripts/runs/1/opencode/',
      },
    });
  });
});
