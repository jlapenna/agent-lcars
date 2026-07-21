import { Firestore, Timestamp } from '@google-cloud/firestore';
import { FakeFirestore } from 'firestore-jest-mock';
import { mockWhere } from 'firestore-jest-mock/mocks/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliSessionDoc, IssueAgentSessionDoc } from '../lib/types';
import { getSessionDoc, listSessionDocs, SESSIONS_COLLECTION } from './store';

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
  branch: 'feat/agent-lcars-cli-sessions',
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

  it('applies source as an equality filter', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [
        { id: cliSession.sessionId, ...cliSession },
        { id: issueAgentSession.sessionId, ...issueAgentSession },
      ],
    }) as unknown as Firestore;

    await listSessionDocs(firestore, { source: 'cli' });

    expect(mockWhere).toHaveBeenCalledWith('source', '==', 'cli');
  });

  it('applies issueNumber as an equality filter', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [
        { id: issueAgentSession.sessionId, ...issueAgentSession },
      ],
    }) as unknown as Firestore;

    await listSessionDocs(firestore, { issueNumber: 2541 });

    expect(mockWhere).toHaveBeenCalledWith('issueNumber', '==', 2541);
  });

  it('composes activeSince, source, and issueNumber filters together', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [
        { id: issueAgentSession.sessionId, ...issueAgentSession },
      ],
    }) as unknown as Firestore;

    await listSessionDocs(firestore, {
      activeSince: '2026-07-11T00:00:00.000Z',
      source: 'issue-agent',
      issueNumber: 2541,
    });

    expect(mockWhere).toHaveBeenCalledWith(
      'lastActivityAt',
      '>=',
      '2026-07-11T00:00:00.000Z',
    );
    expect(mockWhere).toHaveBeenCalledWith('source', '==', 'issue-agent');
    expect(mockWhere).toHaveBeenCalledWith('issueNumber', '==', 2541);
  });

  it('defaults to 100 docs and clamps a larger limit to 200', async () => {
    const manyDocs = Array.from({ length: 250 }, (_, i) => ({
      id: `session-${i}`,
      ...cliSession,
      sessionId: `session-${i}`,
      lastActivityAt: new Date(2026, 6, 1, 0, i).toISOString(),
    }));
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: manyDocs,
    }) as unknown as Firestore;

    expect(await listSessionDocs(firestore)).toHaveLength(100);
    expect(await listSessionDocs(firestore, { limit: 1000 })).toHaveLength(200);
    expect(await listSessionDocs(firestore, { limit: 5 })).toHaveLength(5);
  });
});

describe('getSessionDoc', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns the doc when it exists', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [{ id: cliSession.sessionId, ...cliSession }],
    }) as unknown as Firestore;

    const doc = await getSessionDoc(firestore, cliSession.sessionId);

    expect(doc?.sessionId).toBe(cliSession.sessionId);
  });

  it('returns undefined when the doc does not exist', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [],
    }) as unknown as Firestore;

    expect(await getSessionDoc(firestore, 'missing-session')).toBeUndefined();
  });

  it('converts a stored expireAt Timestamp back into an ISO string', async () => {
    const expireAt = Timestamp.fromDate(new Date('2026-08-11T00:05:00.000Z'));
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [
        { id: cliSession.sessionId, ...cliSession, expireAt },
      ],
    }) as unknown as Firestore;

    const doc = await getSessionDoc(firestore, cliSession.sessionId);

    expect(doc?.expireAt).toBe('2026-08-11T00:05:00.000Z');
  });
});
