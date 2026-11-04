// @vitest-environment node
import {
  issueSourceKey,
  type TrackerIssue,
} from '@agent-lcars/dispatch-contracts';
import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn() }));
vi.mock('./linear-client', async (original) => ({
  ...(await original<typeof import('./linear-client')>()),
  readLinearIssue: mock.read,
  listLinearIssues: mock.list,
}));
vi.mock('./github-app-tokens', () => ({
  createDispatchTokenProvider: () => ({ tokenFor: async () => 'token' }),
}));
vi.mock('./issue-trackers', async (original) => ({
  ...(await original<typeof import('./issue-trackers')>()),
  issueTracker: () => ({ read: mock.read }),
}));
import { readTrackerIssueOwner } from './anchor-owner';
import {
  dispatchIssueSource,
  listIssueSources,
  lookupIssueSource,
  refreshIssueSources,
} from './issue-sources';
import type { WorkContext } from './work-mint';

const org = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const label = '33333333-3333-4333-8333-333333333333';
const issueId = '44444444-4444-4444-8444-444444444444';
const now = '2026-11-04T10:00:00.000Z';
const issue: TrackerIssue = {
  reference: { tracker: 'linear', organizationId: org, issueId },
  identifier: 'ENG-42',
  url: 'https://linear.app/example/issue/ENG-42',
  title: 'Search',
  description: 'Fix search',
  updatedAt: now,
  teamId: team,
  state: 'open',
  labels: [],
  assignees: [],
};
function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => now });
  const context = {
    principal: {
      principal: 'user:joe',
      subject: 'github:joe',
      via: 'session',
      pipelines: ['codex'],
      scopes: new Set(['work.operator']),
    },
    runtime: {
      store,
      orchestrator,
      drain: vi.fn(async () => ({ dispatched: [], reported: [], failed: [] })),
    },
    now: () => new Date(now),
    cliSessions: vi.fn(async () => ({ sessions: [], warnings: [] })),
    sessionsFor: async () => [],
    sessionDocsForRuns: async () => [],
    getSessionDoc: async () => undefined,
    grants: () => [],
  } as unknown as WorkContext;
  return { store, orchestrator, context };
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.read.mockResolvedValue(issue);
  vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', 'test');
  vi.stubEnv('AGENT_LCARS_LINEAR_WEBHOOK_SECRET', 'test');
  vi.stubEnv(
    'AGENT_LCARS_LINEAR',
    JSON.stringify({
      organizationId: org,
      routes: [
        {
          teamId: team,
          labelId: label,
          repo: 'owner/repo',
          pipeline: 'codex',
          principal: 'svc:linear',
        },
      ],
    }),
  );
  vi.stubEnv(
    'AGENT_LCARS_WORK_GRANTS',
    JSON.stringify([
      {
        principal: 'svc:linear',
        subjects: ['adapter'],
        channel: 'linear',
        scopes: ['work.operator'],
        pipelines: ['codex'],
      },
    ]),
  );
  vi.stubEnv(
    'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
    'owner/repo,owner/other',
  );
  vi.stubEnv(
    'AGENT_LCARS_WATCHED_REPOS',
    JSON.stringify([
      { owner: 'owner', name: 'repo', alias: 'repo' },
      { owner: 'owner', name: 'other', alias: 'other' },
    ]),
  );
});
afterEach(() => vi.unstubAllEnvs());
describe('first-class issue source operations', () => {
  it('reads unowned source and ownership without manufacturing a Work binding', async () => {
    const f = fixture();
    const source = await lookupIssueSource(f.context, {
      tracker: 'linear',
      issue: 'ENG-42',
    });
    expect(source).toMatchObject({ issue, repo: 'owner/repo' });
    expect(
      await readTrackerIssueOwner(f.context, issue, 'owner/repo'),
    ).toMatchObject({ verdict: 'none', complete: true });
    expect(
      await f.store.readSourceWorkId(issueSourceKey(issue.reference)),
    ).toBeUndefined();
    expect(await f.store.readTrackerIssue(issue.reference)).toBeUndefined();
    expect(await f.store.listNativeTasks(10)).toHaveLength(0);
  });
  it('refreshes one bounded page as metadata without dispatch and preserves explicit cursor', async () => {
    const f = fixture();
    mock.list.mockResolvedValue({ issues: [issue], nextCursor: 'page-two' });
    expect(
      await refreshIssueSources(f.context, {
        tracker: 'linear',
        teamId: team,
        cursor: 'page-one',
      }),
    ).toEqual({ refreshed: 1, nextCursor: 'page-two' });
    expect(mock.list).toHaveBeenCalledWith(org, team, 'page-one');
    expect(
      (await listIssueSources(f.context, { tracker: 'linear', limit: 1 }))
        .issues,
    ).toEqual([expect.objectContaining({ issue, repo: 'owner/repo' })]);
    expect(await f.store.listNativeTasks(10)).toHaveLength(0);
  });
  it.each(['linear', 'github'] as const)(
    'uses the same initial and retried command receipt for %s after settlement',
    async (tracker) => {
      const f = fixture();
      const source: TrackerIssue =
        tracker === 'linear'
          ? issue
          : {
              ...issue,
              reference: { tracker: 'github', repo: 'owner/repo', issue: 42 },
              identifier: 'owner/repo#42',
              url: 'https://github.com/owner/repo/issues/42',
            };
      mock.read.mockResolvedValue(source);
      const input = {
        issue: source.reference,
        pipeline: 'codex' as const,
        requestId: 'command-1',
      };
      const first = await dispatchIssueSource(f.context, input);
      await f.orchestrator.confirmDispatch(first.runId);
      await f.orchestrator.report(first.runId, { ok: true, summary: 'done' });
      const retry = await dispatchIssueSource(f.context, input);
      expect(retry.runId).toBe(first.runId);
      expect(
        await f.store.listRuns(
          source.reference.tracker === 'github'
            ? source.reference
            : { workId: first.workId! },
        ),
      ).toHaveLength(1);
    },
  );
  it('recovers a completed/closed source receipt and rejects changed provider selection', async () => {
    const f = fixture();
    const input = {
      issue: issue.reference,
      pipeline: 'codex' as const,
      requestId: 'lost-response',
    };
    const first = await dispatchIssueSource(f.context, input);
    await f.orchestrator.confirmDispatch(first.runId);
    await f.orchestrator.report(first.runId, { ok: true, summary: 'done' });
    mock.read.mockResolvedValue({ ...issue, state: 'closed' });
    expect(await dispatchIssueSource(f.context, input)).toEqual(first);
    f.context.principal = {
      ...f.context.principal!,
      pipelines: ['codex', 'claude'],
    };
    await expect(
      dispatchIssueSource(f.context, { ...input, pipeline: 'claude' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await f.store.listRuns({ workId: first.workId! })).toHaveLength(1);
  });
  it('authorizes an existing binding against its immutable target after a source move', async () => {
    const f = fixture();
    const first = await dispatchIssueSource(f.context, {
      issue: issue.reference,
      pipeline: 'codex',
      requestId: 'first',
    });
    await f.store.writeTrackerIssue({
      issue: { ...issue, updatedAt: '2026-11-04T10:00:01.000Z' },
      repo: 'owner/other',
      observedAt: now,
    });
    f.context.principal = {
      ...f.context.principal!,
      sourceRepository: 'owner/other',
    };
    expect(
      (await listIssueSources(f.context, { tracker: 'linear', limit: 50 }))
        .issues,
    ).toEqual([]);
    await expect(
      lookupIssueSource(f.context, { tracker: 'linear', issue: 'ENG-42' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await f.store.readSourceWorkId(issueSourceKey(issue.reference)),
    ).toBe(first.workId);
  });
  it('rejects provider-crossed and malformed page cursors', async () => {
    const f = fixture();
    await expect(
      listIssueSources(f.context, {
        tracker: 'linear',
        limit: 50,
        cursor: 'not-json',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const cursor = Buffer.from(
      JSON.stringify({
        tracker: 'github',
        anchor: { repo: 'owner/repo', issue: 42 },
        sourceUpdatedAt: now,
      }),
    ).toString('base64url');
    await expect(
      listIssueSources(f.context, { tracker: 'linear', limit: 50, cursor }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
