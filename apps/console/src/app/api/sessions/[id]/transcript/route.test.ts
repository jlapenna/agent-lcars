import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@agent-lcars/telemetry';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getFirestore: vi.fn(),
  getSessionDoc: vi.fn(),
  getSessionTranscript: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: mocks.getFirestore,
  getSessionDoc: mocks.getSessionDoc,
}));
vi.mock('@/lib/session-transcript', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/session-transcript')
  >('@/lib/session-transcript');
  return {
    ...actual,
    getSessionTranscript: mocks.getSessionTranscript,
  };
});

import { encodeTranscriptCursor } from '@/lib/session-transcript';

import { GET } from './route';

function makeRequest(
  id: string,
  query = '',
): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(
      `http://localhost/api/sessions/${encodeURIComponent(id)}/transcript${query}`,
    ),
    { params: Promise.resolve({ id }) },
  ];
}

function cliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'cli-1',
    source: 'cli',
    agent: 'codex',
    liveness: 'ended',
    startedAt: '2026-10-01T00:00:00Z',
    lastActivityAt: '2026-10-01T00:05:00Z',
    turns: 2,
    toolCallCounts: {},
    tokens: {
      inputTokens: 10,
      outputTokens: 5,
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
    agent: 'claude-code',
    repo: { owner: 'jlapenna', name: 'agent-lcars' },
    liveness: 'ended',
    startedAt: '2026-10-01T00:00:00Z',
    lastActivityAt: '2026-10-01T00:05:00Z',
    turns: 2,
    toolCallCounts: {},
    tokens: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    transcriptGcsUri: 'gs://bucket/runs/1/session.jsonl',
    renderable: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/sessions/[id]/transcript', () => {
  it('rejects unauthenticated and non-admin callers with 401 and private, no-store', async () => {
    mocks.auth.mockResolvedValue(null);
    const anon = await GET(...makeRequest('agent-1'));
    expect(anon.status).toBe(401);
    expect(anon.headers.get('Cache-Control')).toBe('private, no-store');

    mocks.auth.mockResolvedValue({ user: { isAdmin: false } });
    const operator = await GET(...makeRequest('agent-1'));
    expect(operator.status).toBe(401);
    expect(mocks.getSessionDoc).not.toHaveBeenCalled();
  });

  it('returns 404 when the session document does not exist or has no consented archive', async () => {
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    mocks.getSessionDoc.mockResolvedValue(undefined);
    expect((await GET(...makeRequest('missing'))).status).toBe(404);

    mocks.getSessionDoc.mockResolvedValue(cliDoc());
    expect((await GET(...makeRequest('cli-1'))).status).toBe(404);
    expect(mocks.getSessionTranscript).not.toHaveBeenCalled();
  });

  it('returns 410 when CLI archive retention expired or consent was revoked mid-session', async () => {
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    mocks.getSessionDoc.mockResolvedValue(
      cliDoc({
        transcriptGcsUri: 'gs://cli/codex/cli-1.jsonl',
        renderable: true,
        cliTranscriptArchive: {
          status: 'available',
          expiresAt: '2000-01-01T00:00:00Z',
        },
      }),
    );
    const expired = await GET(...makeRequest('cli-1'));
    expect(expired.status).toBe(410);
    expect(expired.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await expired.json()).toEqual({
      events: [],
      hasMore: false,
      warning: 'Transcript unavailable (archive retention expired).',
    });

    mocks.getSessionDoc.mockResolvedValue(
      cliDoc({ cliTranscriptArchive: { status: 'expired' } }),
    );
    const revoked = await GET(...makeRequest('cli-1'));
    expect(revoked.status).toBe(410);
    expect(mocks.getSessionTranscript).not.toHaveBeenCalled();
  });

  it('rejects malformed or mismatched-agent cursors with 400', async () => {
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    mocks.getSessionDoc.mockResolvedValue(agentDoc({ agent: 'claude-code' }));

    const malformed = await GET(...makeRequest('agent-1', '?cursor=!!!'));
    expect(malformed.status).toBe(400);

    const wrongAgent = encodeTranscriptCursor({
      v: 1,
      agent: 'codex',
      mode: 'bytes',
      offset: 512,
    });
    const mismatch = await GET(
      ...makeRequest('agent-1', `?cursor=${wrongAgent}`),
    );
    expect(mismatch.status).toBe(400);
    expect(mocks.getSessionTranscript).not.toHaveBeenCalled();
  });

  it('fetches the requested cursor page and returns private, no-store JSON', async () => {
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    mocks.getSessionDoc.mockResolvedValue(agentDoc({ agent: 'claude-code' }));
    const cursor = encodeTranscriptCursor({
      v: 1,
      agent: 'claude-code',
      mode: 'bytes',
      offset: 2048,
      state: { inSidechain: true },
    });
    mocks.getSessionTranscript.mockResolvedValue({
      events: [{ kind: 'text', role: 'assistant', text: 'page 2' }],
      nextCursor: 'next-token',
      hasMore: true,
    });

    const response = await GET(
      ...makeRequest('agent-1', `?cursor=${encodeURIComponent(cursor)}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      events: [{ kind: 'text', role: 'assistant', text: 'page 2' }],
      hasMore: true,
      nextCursor: 'next-token',
    });
    expect(mocks.getSessionTranscript).toHaveBeenCalledWith(
      'gs://bucket/runs/1/session.jsonl',
      'claude-code',
      {
        cursor: {
          v: 1,
          agent: 'claude-code',
          mode: 'bytes',
          offset: 2048,
          state: { inSidechain: true },
        },
      },
    );
  });
});
