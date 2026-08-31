import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@agent-lcars/telemetry';
import { listSessionDocs } from '@agent-lcars/telemetry/server';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import {
  configureTestWatchedRepos,
  TEST_HOME_REPOSITORY,
  TEST_SPRINKLES_REPOSITORY,
} from '../test-support/watched-repos';
import {
  DEFAULT_ARCHIVE_DAYS,
  getSessionArchive,
  MAX_ARCHIVE_DAYS,
  parseSessionArchiveQuery,
  toSessionRow,
} from './session-archive';

vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
  listSessionDocs: vi.fn(),
}));

beforeEach(() => {
  configureTestWatchedRepos([TEST_HOME_REPOSITORY, TEST_SPRINKLES_REPOSITORY]);
});

afterEach(() => {
  configureTestWatchedRepos([TEST_HOME_REPOSITORY]);
});

function cliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'cli-1',
    source: 'cli',
    agent: 'claude-code',
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
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    host: 'joes-workstation',
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
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
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

describe('parseSessionArchiveQuery', () => {
  it('defaults to 14 days with no filters when the params are empty', () => {
    expect(parseSessionArchiveQuery({})).toEqual({
      days: DEFAULT_ARCHIVE_DAYS,
      source: undefined,
      issueNumber: undefined,
      repo: undefined,
    });
  });

  it('parses a `repo=owner/name` param matching a watched repo', () => {
    expect(
      parseSessionArchiveQuery({
        repo: 'supersprinklesracing/sprinkles',
      }).repo,
    ).toEqual({
      owner: 'supersprinklesracing',
      name: 'sprinkles',
      alias: 'sprinkles',
    });
  });

  it('ignores a `repo` value that matches no watched repo', () => {
    expect(
      parseSessionArchiveQuery({ repo: 'nope/not-watched' }).repo,
    ).toBeUndefined();
  });

  it('parses a valid days/source/issue combination', () => {
    expect(
      parseSessionArchiveQuery({ days: '30', source: 'cli', issue: '2541' }),
    ).toEqual({ days: 30, source: 'cli', issueNumber: 2541 });
  });

  it('clamps days above the 90-day maximum', () => {
    expect(parseSessionArchiveQuery({ days: '9000' }).days).toBe(
      MAX_ARCHIVE_DAYS,
    );
  });

  it('falls back to the default for a non-numeric or non-positive days value', () => {
    expect(parseSessionArchiveQuery({ days: 'nonsense' }).days).toBe(
      DEFAULT_ARCHIVE_DAYS,
    );
    expect(parseSessionArchiveQuery({ days: '-5' }).days).toBe(
      DEFAULT_ARCHIVE_DAYS,
    );
    expect(parseSessionArchiveQuery({ days: '0' }).days).toBe(
      DEFAULT_ARCHIVE_DAYS,
    );
  });

  it('ignores an invalid source value rather than passing it through', () => {
    expect(
      parseSessionArchiveQuery({ source: 'not-a-real-source' }).source,
    ).toBeUndefined();
  });

  it('ignores a non-positive or non-integer issue value', () => {
    expect(
      parseSessionArchiveQuery({ issue: '0' }).issueNumber,
    ).toBeUndefined();
    expect(
      parseSessionArchiveQuery({ issue: 'abc' }).issueNumber,
    ).toBeUndefined();
    expect(
      parseSessionArchiveQuery({ issue: '1.5' }).issueNumber,
    ).toBeUndefined();
  });

  it('takes the first value when a param is repeated (array form)', () => {
    expect(parseSessionArchiveQuery({ days: ['7', '30'] }).days).toBe(7);
  });
});

describe('toSessionRow', () => {
  const now = '2026-07-10T10:10:00.000Z';

  it('builds a CLI session row with host and no issue/run fields', () => {
    const row = toSessionRow(cliDoc({ host: 'pike' }), now);

    expect(row.source).toBe('cli');
    expect(row.host).toBe('pike');
    expect(row.issueNumber).toBeUndefined();
    expect(row.runId).toBeUndefined();
  });

  it('uses the persisted explicit agent', () => {
    expect(toSessionRow(cliDoc(), now).agent).toBe('claude-code');
    expect(toSessionRow(cliDoc({ agent: 'opencode' }), now).agent).toBe(
      'opencode',
    );
  });

  it('builds an issue-agent row with issue/run links when present', () => {
    const row = toSessionRow(
      agentDoc({ issueNumber: 42, runId: '999888777' }),
      now,
    );

    expect(row.issueNumber).toBe(42);
    expect(row.issueUrl).toBe(
      'https://github.com/supersprinklesracing/sprinkles/issues/42',
    );
    expect(row.runUrl).toBe(
      'https://github.com/supersprinklesracing/sprinkles/actions/runs/999888777',
    );
  });

  it('does not invent an Actions URL for an opaque broker run ID', () => {
    const row = toSessionRow(
      agentDoc({ runId: 'sprinkles/4829/r-queue-123' }),
      now,
    );

    expect(row.runId).toBe('sprinkles/4829/r-queue-123');
    expect(row.runUrl).toBeUndefined();
  });

  it('uses useful task context instead of opaque IDs for titleless sessions', () => {
    expect(
      toSessionRow(agentDoc({ title: undefined, issueNumber: 7 }), now).title,
    ).toBe('Issue #7');
    expect(
      toSessionRow(cliDoc({ title: undefined, branch: 'fix/mobile-ui' }), now)
        .title,
    ).toBe('fix/mobile-ui');
    expect(
      toSessionRow(
        cliDoc({ title: undefined, branch: undefined, host: 'runner-1' }),
        now,
      ).title,
    ).toBe('Session on runner-1');
    expect(
      toSessionRow(
        cliDoc({ title: undefined, branch: undefined, host: undefined }),
        now,
      ).title,
    ).toBe('Untitled CLI session');
  });

  it('maps deliverables.prNumbers into PR links', () => {
    const row = toSessionRow(
      cliDoc({ deliverables: { prNumbers: [10, 20], commitShas: [] } }),
      now,
    );

    expect(row.prUrls).toEqual([
      {
        number: 10,
        url: 'https://github.com/supersprinklesracing/sprinkles/pull/10',
      },
      {
        number: 20,
        url: 'https://github.com/supersprinklesracing/sprinkles/pull/20',
      },
    ]);
  });

  it('omits totalCostUsd when the doc has none', () => {
    expect(toSessionRow(cliDoc(), now).totalCostUsd).toBeUndefined();
  });

  it('carries totalCostUsd when the doc has one', () => {
    expect(toSessionRow(cliDoc({ totalCostUsd: 0.42 }), now).totalCostUsd).toBe(
      0.42,
    );
  });

  it('carries the agent-declared status and its own age through, distinct from lastActivityAt (#1257)', () => {
    const row = toSessionRow(
      cliDoc({
        lastActivityAt: '2026-07-10T10:09:00.000Z',
        status: 'waiting on CI for #1247',
        statusUpdatedAt: '2026-07-10T09:30:00.000Z',
      }),
      now,
    );

    expect(row.status).toBe('waiting on CI for #1247');
    expect(row.statusUpdatedAt).toBe('2026-07-10T09:30:00.000Z');
    expect(row.statusUpdatedAt).not.toBe(row.lastActivityAt);
  });

  it('omits status and statusUpdatedAt when the doc has none (#1257)', () => {
    const row = toSessionRow(cliDoc(), now);

    expect(row.status).toBeUndefined();
    expect(row.statusUpdatedAt).toBeUndefined();
  });

  it('sums input+output tokens', () => {
    expect(toSessionRow(cliDoc(), now).totalTokens).toBe(150);
  });

  it('cost-weights cache-creation and cache-read tokens in the total', () => {
    const doc = cliDoc({
      tokens: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 20,
        cacheReadTokens: 300,
      },
    });
    expect(toSessionRow(doc, now).totalTokens).toBe(205);
  });
});

describe('getSessionArchive', () => {
  afterEach(() => vi.resetAllMocks());

  it('passes activeSince/source/issueNumber/limit through to the store', async () => {
    (listSessionDocs as Mock).mockResolvedValue([]);

    await getSessionArchive({ days: 7, source: 'cli', issueNumber: 42 });

    expect(listSessionDocs).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        source: 'cli',
        issueNumber: 42,
        limit: 200,
      }),
    );
  });

  it('derives rows and a ledger from the same doc set', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      cliDoc({ sessionId: 'c1' }),
      agentDoc({ sessionId: 'a1', issueNumber: 5, totalCostUsd: 1 }),
    ]);

    const result = await getSessionArchive({ days: 14 });

    expect(result.rows).toHaveLength(2);
    expect(result.ledger.byIssue.some((r) => r.issueNumber === 5)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('narrows to the given repo, in-memory, after the fetch', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      cliDoc({
        sessionId: 'c1',
        repo: { owner: 'org-a', name: 'repo-a' },
      }),
      agentDoc({
        sessionId: 'a1',
        repo: { owner: 'org-b', name: 'repo-b' },
      }),
    ]);

    const result = await getSessionArchive({
      days: 14,
      repo: { owner: 'org-b', name: 'repo-b' },
    });

    expect(result.rows.map((r) => r.sessionId)).toEqual(['a1']);
    // The repo filter is applied client-side, not passed to the store.
    expect(listSessionDocs).toHaveBeenCalledWith(
      undefined,
      expect.not.objectContaining({ repo: expect.anything() }),
    );
  });

  it('does not include a repo-less CLI doc in a GitHub-repository filter', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      cliDoc({ sessionId: 'legacy', repo: undefined }),
      agentDoc({
        sessionId: 'other-repo',
        repo: { owner: 'org-b', name: 'repo-b' },
      }),
    ]);

    const result = await getSessionArchive({
      days: 14,
      repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    });

    expect(result.rows).toEqual([]);
  });

  it('degrades to an empty result with a warning when the store throws', async () => {
    (listSessionDocs as Mock).mockRejectedValue(new Error('boom'));

    const result = await getSessionArchive({ days: 14 });

    expect(result.rows).toEqual([]);
    expect(result.ledger).toEqual({ byIssue: [], byWeek: [] });
    expect(result.warnings).toHaveLength(1);
  });
});
