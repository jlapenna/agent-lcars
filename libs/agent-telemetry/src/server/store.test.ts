import { Firestore, Timestamp } from '@google-cloud/firestore';
import { FakeFirestore } from 'firestore-jest-mock';
import { mockWhere } from 'firestore-jest-mock/mocks/firestore';

import { CliSessionDoc, IssueAgentSessionDoc } from '../lib/types';
import { listSessionDocs, SESSIONS_COLLECTION } from './store';
import { describe, it, expect, afterEach, vi } from 'vitest';

const cliSession: CliSessionDoc = {
  sessionId: 'cli-session-1',
  source: 'cli',
  liveness: 'live',
  startedAt: '2026-07-12T00:00:00.000Z',
  lastActivityAt: '2026-07-12T00:05:00.000Z',
  expireAt: '2026-08-11T00:05:00.000Z',
  turns: 4,
  toolCallCounts: { Read: 2 },
  tokens: {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  host: 'joes-workstation',
  branch: 'feat/agent-console-cli-sessions',
  deliverables: { prNumbers: [], commitShas: [] },
};

const issueAgentSession: IssueAgentSessionDoc = {
  sessionId: 'runner-session-1',
  source: 'issue-agent',
  liveness: 'ended',
  startedAt: '2026-07-11T00:00:00.000Z',
  lastActivityAt: '2026-07-11T00:30:00.000Z',
  expireAt: '2026-08-10T00:30:00.000Z',
  turns: 12,
  toolCallCounts: {},
  tokens: {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  issueNumber: 2541,
  deliverables: { prNumbers: [2579], commitShas: [] },
};

describe('listSessionDocs', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns every doc in the sessions collection, source-agnostic, newest activity first', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [
        { id: issueAgentSession.sessionId, ...issueAgentSession },
        { id: cliSession.sessionId, ...cliSession },
      ],
    }) as unknown as Firestore;

    const docs = await listSessionDocs(firestore);

    expect(docs).toHaveLength(2);
    expect(docs.map((doc) => doc.sessionId)).toEqual([
      'cli-session-1',
      'runner-session-1',
    ]);
  });

  it('applies activeSince as a lastActivityAt range filter', async () => {
    // FakeFirestore records but does not evaluate query filters, so this
    // asserts the query shape; the range semantics are Firestore's own.
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [
        { id: cliSession.sessionId, ...cliSession },
        { id: issueAgentSession.sessionId, ...issueAgentSession },
      ],
    }) as unknown as Firestore;

    await listSessionDocs(firestore, {
      activeSince: '2026-07-11T12:00:00.000Z',
    });

    expect(mockWhere).toHaveBeenCalledWith(
      'lastActivityAt',
      '>=',
      '2026-07-11T12:00:00.000Z',
    );
  });

  it('does not filter when no activeSince is given', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [{ id: cliSession.sessionId, ...cliSession }],
    }) as unknown as Firestore;

    await listSessionDocs(firestore);

    expect(mockWhere).not.toHaveBeenCalled();
  });

  it('returns an empty list when the collection has no docs', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [],
    }) as unknown as Firestore;

    expect(await listSessionDocs(firestore)).toEqual([]);
  });

  it('converts a stored expireAt Timestamp back into an ISO string', async () => {
    const expireAt = Timestamp.fromDate(new Date('2026-08-11T00:05:00.000Z'));
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [
        { id: cliSession.sessionId, ...cliSession, expireAt },
      ],
    }) as unknown as Firestore;

    const [doc] = await listSessionDocs(firestore);

    expect(doc.expireAt).toBe('2026-08-11T00:05:00.000Z');
  });

  it('leaves a legacy doc missing expireAt as-is rather than throwing', async () => {
    const { expireAt: _expireAt, ...legacyDoc } = cliSession;
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [{ id: legacyDoc.sessionId, ...legacyDoc }],
    }) as unknown as Firestore;

    const [doc] = await listSessionDocs(firestore);

    expect(doc.expireAt).toBeUndefined();
  });
});
