import { Firestore } from '@google-cloud/firestore';
import { FakeFirestore } from 'firestore-jest-mock';

import { CliSessionDoc, IssueAgentSessionDoc } from '../lib/types';
import { listSessionDocs, SESSIONS_COLLECTION } from './store';

const cliSession: CliSessionDoc = {
  sessionId: 'cli-session-1',
  source: 'cli',
  liveness: 'live',
  startedAt: '2026-07-12T00:00:00.000Z',
  lastActivityAt: '2026-07-12T00:05:00.000Z',
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
  it('returns every doc in the sessions collection, source-agnostic', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [
        { id: cliSession.sessionId, ...cliSession },
        { id: issueAgentSession.sessionId, ...issueAgentSession },
      ],
    }) as unknown as Firestore;

    const docs = await listSessionDocs(firestore);

    expect(docs).toHaveLength(2);
    expect(docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'cli-session-1', source: 'cli' }),
        expect.objectContaining({
          sessionId: 'runner-session-1',
          source: 'issue-agent',
        }),
      ]),
    );
  });

  it('returns an empty list when the collection has no docs', async () => {
    const firestore = new FakeFirestore({
      [SESSIONS_COLLECTION]: [],
    }) as unknown as Firestore;

    expect(await listSessionDocs(firestore)).toEqual([]);
  });
});
