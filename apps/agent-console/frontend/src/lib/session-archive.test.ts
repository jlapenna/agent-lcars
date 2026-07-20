import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@repo/agent-telemetry';
import { listSessionDocs } from '@repo/agent-telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  DEFAULT_ARCHIVE_DAYS,
  getSessionArchive,
  MAX_ARCHIVE_DAYS,
  parseSessionArchiveQuery,
  toSessionRow,
} from './session-archive';

vi.mock('@repo/agent-telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
  listSessionDocs: vi.fn(),
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
    });
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

  it('resolves agent via sessionAgent(), defaulting to claude-code when the doc has none', () => {
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
      'https://github.com/supersprinklesracing/members/issues/42',
    );
    expect(row.runUrl).toBe(
      'https://github.com/supersprinklesracing/members/actions/runs/999888777',
    );
  });

  it('falls back to "Issue #N" for a titleless issue-agent session, else the sessionId', () => {
    expect(
      toSessionRow(agentDoc({ title: undefined, issueNumber: 7 }), now).title,
    ).toBe('Issue #7');
    expect(
      toSessionRow(cliDoc({ title: undefined, sessionId: 'raw-id' }), now)
        .title,
    ).toBe('raw-id');
  });

  it('maps deliverables.prNumbers into PR links', () => {
    const row = toSessionRow(
      cliDoc({ deliverables: { prNumbers: [10, 20], commitShas: [] } }),
      now,
    );

    expect(row.prUrls).toEqual([
      {
        number: 10,
        url: 'https://github.com/supersprinklesracing/members/pull/10',
      },
      {
        number: 20,
        url: 'https://github.com/supersprinklesracing/members/pull/20',
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

  it('sums input+output tokens', () => {
    expect(toSessionRow(cliDoc(), now).totalTokens).toBe(150);
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

  it('degrades to an empty result with a warning when the store throws', async () => {
    (listSessionDocs as Mock).mockRejectedValue(new Error('boom'));

    const result = await getSessionArchive({ days: 14 });

    expect(result.rows).toEqual([]);
    expect(result.ledger).toEqual({ byIssue: [], byWeek: [] });
    expect(result.warnings).toHaveLength(1);
  });
});
