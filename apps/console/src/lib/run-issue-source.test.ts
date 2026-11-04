// @vitest-environment node
import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashRunToken } from './run-token';
import { createRunsHandler, type RunsContext } from './runs-router';
const org = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const label = '33333333-3333-4333-8333-333333333333';
const issueId = '44444444-4444-4444-8444-444444444444';
const commentId = '55555555-5555-4555-8555-555555555555';
const now = '2026-11-04T10:00:00.000Z';
const admitted: TrackerIssue = {
  reference: { tracker: 'linear', organizationId: org, issueId },
  identifier: 'ENG-42',
  title: 'Search',
  description: 'Original request',
  url: 'https://linear.app/example/issue/ENG-42',
  state: 'open',
  teamId: team,
  updatedAt: now,
  labels: [],
  assignees: [],
};
beforeEach(() => {
  vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', 'server-only-api-key');
  vi.stubEnv('AGENT_LCARS_LINEAR_WEBHOOK_SECRET', 'secret');
  vi.stubEnv(
    'AGENT_LCARS_LINEAR',
    JSON.stringify({
      organizationId: org,
      routes: [
        {
          teamId: team,
          labelId: label,
          repo: 'owner/repo',
          pipeline: 'claude',
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
        pipelines: ['claude'],
        scopes: ['work.operator'],
        channel: 'linear',
      },
    ]),
  );
  vi.stubEnv('AGENT_LCARS_CONTROL_PLANE_REPOSITORIES', 'owner/repo');
  vi.stubEnv(
    'AGENT_LCARS_WATCHED_REPOS',
    JSON.stringify([{ owner: 'owner', name: 'repo', alias: 'repo' }]),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => now });
  const taskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E4H' };
  const decision = await orchestrator.request({
    taskId,
    requestId: 'source',
    pipeline: 'claude',
    params: { mode: 'implement' },
    issue: admitted,
    work: {
      origin: { principal: 'svc:linear', channel: 'linear' },
      spec: {
        title: 'Search',
        description: 'Original request',
        pipeline: 'claude',
        target: { repo: 'owner/repo' },
      },
    },
  });
  if (isRefusal(decision)) throw new Error(decision.reason);
  const run = decidedRun(decision);
  const token = 'this-run-only-token';
  await orchestrator.confirmDispatch(run.runId);
  await store.enqueueRun({ runId: run.runId, now });
  await store.claimQueuedRun({
    pipelines: ['claude'],
    claimedBy: 'worker',
    tokenHash: hashRunToken(token),
    now,
  });
  const source = {
    teamId: team,
    description: 'Current evidence',
    onComments: async () => {
      /* race seam */
    },
  };
  const operations: { query: string; variables: Record<string, unknown> }[] =
    [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(init?.body as string);
      operations.push(request);
      if (request.query.includes('LcarsIssueComments')) {
        await source.onComments();
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [
                  {
                    id: commentId,
                    body: 'Newest comment',
                    url: `${admitted.url}#comment`,
                    createdAt: now,
                    updatedAt: now,
                    user: { id: org, name: 'Joe' },
                    issue: { id: issueId },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'following-page' },
              },
            },
          },
        });
      }
      return Response.json({
        data: {
          organization: { id: org },
          issue: {
            id: issueId,
            identifier: admitted.identifier,
            title: admitted.title,
            description: source.description,
            url: admitted.url,
            updatedAt: '2026-11-04T10:00:01.000Z',
            team: { id: source.teamId },
            state: { id: team, name: 'Todo', type: 'unstarted' },
            assignee: null,
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      });
    }),
  );
  const context = {
    store,
    orchestrator,
    bearerToken: token,
    tokens: { tokenFor: async () => 'unused-github-token' },
    now: () => new Date(now),
  } as unknown as RunsContext;
  const read = async (bearerToken = token) => {
    const { response } = await createRunsHandler().handle(
      new Request(
        `https://lcars.test/api/work/v1/runs/${encodeURIComponent(run.runId)}/issue-source?cursor=earlier-page`,
      ),
      { prefix: '/api/work/v1', context: { ...context, bearerToken } },
    );
    return { status: response?.status, body: await response?.json() };
  };
  return { store, orchestrator, run, token, source, operations, read };
}
describe('run-scoped issue source HTTP boundary', () => {
  it('returns current source and paginated comments alongside the immutable admitted snapshot', async () => {
    const f = await fixture();
    const result = await f.read();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      admittedIssue: admitted,
      issue: { description: 'Current evidence' },
      comments: [{ body: 'Newest comment' }],
      nextCursor: 'following-page',
    });
    expect(f.operations.at(-1)?.variables).toEqual({
      id: issueId,
      after: 'earlier-page',
    });
    expect(JSON.stringify(result.body)).not.toContain('server-only-api-key');
    expect(JSON.stringify(result.body)).not.toContain(f.token);
  });
  it('refuses a foreign token before any source lookup', async () => {
    const f = await fixture();
    expect((await f.read('other-run-token')).status).toBe(401);
    expect(f.operations).toEqual([]);
  });
  it('revalidates cancellation while the provider comment read is in flight', async () => {
    const f = await fixture();
    f.source.onComments = async () => {
      await f.orchestrator.cancel(f.run.runId);
    };
    const result = await f.read();
    expect(result.status).toBe(401);
    expect(JSON.stringify(result.body)).not.toContain('Newest comment');
  });
  it('revalidates a replaced claim while comments are in flight', async () => {
    const f = await fixture();
    f.source.onComments = async () => {
      const released = await f.store.releaseQueuedRunClaim({
        runId: f.run.runId,
        claimedBy: 'worker',
        tokenHash: hashRunToken(f.token),
        now,
      });
      if (!released)
        throw new Error('Fixture could not release its original claim');
      await f.store.claimQueuedRun({
        pipelines: ['claude'],
        claimedBy: 'replacement',
        tokenHash: hashRunToken('replacement-token'),
        now,
      });
    };
    const result = await f.read();
    expect(result.status).toBe(401);
    expect(JSON.stringify(result.body)).not.toContain('Newest comment');
  });
  it('refuses a moved source before reading comments for another repository scope', async () => {
    const f = await fixture();
    f.source.teamId = org;
    const result = await f.read();
    expect(result.status).toBe(403);
    expect(f.operations).toHaveLength(1);
  });
});
