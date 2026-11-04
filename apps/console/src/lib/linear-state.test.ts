// @vitest-environment node
import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishLinearState } from './linear-state';

const org = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const issueId = '44444444-4444-4444-8444-444444444444';
const label = '33333333-3333-4333-8333-333333333333';
const started = '55555555-5555-4555-8555-555555555555';
const completed = '66666666-6666-4666-8666-666666666666';
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
  status: { id: label, name: 'Backlog', type: 'backlog' },
  labels: [],
  assignees: [],
};
beforeEach(() => {
  vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', 'test');
  vi.stubEnv('AGENT_LCARS_LINEAR_WEBHOOK_SECRET', 'test');
  vi.stubEnv(
    'AGENT_LCARS_LINEAR',
    JSON.stringify({
      organizationId: org,
      teams: [
        {
          teamId: team,
          repo: 'owner/repo',
          states: {
            started,
            parked: started,
            failed: started,
            canceled: label,
            completed,
          },
        },
      ],
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
  vi.stubEnv('AGENT_LCARS_CONTROL_PLANE_REPOSITORIES', 'owner/repo');
  vi.stubEnv(
    'AGENT_LCARS_WATCHED_REPOS',
    JSON.stringify([{ owner: 'owner', name: 'repo', alias: 'repo' }]),
  );
});
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => now });
  const taskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E4H' };
  const admitted = await orchestrator.request({
    taskId,
    requestId: 'initial',
    pipeline: 'codex',
    issue,
    params: { mode: 'implement' },
    work: {
      origin: {
        principal: 'svc:linear',
        channel: 'linear',
        thread: JSON.stringify({ organizationId: org, issueId }),
      },
      spec: {
        title: 'Search',
        description: 'Fix',
        pipeline: 'codex',
        target: { repo: 'owner/repo' },
      },
    },
  });
  if (isRefusal(admitted)) throw new Error(admitted.reason);
  const current = { closed: false, category: 'started', stateTeam: team };
  const writes: unknown[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(init?.body as string);
    if (request.query.includes('LcarsIssue('))
      return Response.json({
        data: {
          organization: { id: org },
          issue: {
            id: issueId,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            url: issue.url,
            updatedAt: now,
            archivedAt: null,
            trashed: false,
            team: { id: team },
            state: {
              id: label,
              name: 'State',
              type: current.closed ? 'completed' : 'backlog',
            },
            assignee: null,
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      });
    if (request.query.includes('query LcarsWorkflowState'))
      return Response.json({
        data: {
          workflowState: {
            id: request.variables.id,
            type: current.category,
            team: { id: current.stateTeam },
          },
        },
      });
    writes.push(request.variables);
    return Response.json({
      data: { issueUpdate: { success: true, issue: { id: issueId } } },
    });
  });
  return {
    store,
    orchestrator,
    run: decidedRun(admitted),
    taskId,
    current,
    writes,
    fetchImpl,
  };
}
describe('Linear source status publication', () => {
  it('records a durable started effect only on the authenticated first provider heartbeat', async () => {
    const f = await fixture();
    await f.orchestrator.confirmDispatch(f.run.runId);
    await f.store.enqueueRun({ runId: f.run.runId, now });
    const token = 'a'.repeat(64);
    await f.store.claimQueuedRun({
      pipelines: ['codex'],
      claimedBy: 'runner',
      tokenHash: token,
      now,
    });
    await f.orchestrator.renew(f.run.runId, token, false);
    expect(
      (
        await f.store.claimPendingOutbox({
          limit: 20,
          now,
          leaseExpiresAt: '2026-11-04T10:01:00Z',
        })
      ).filter((entry) => entry.kind === 'publish-issue-start'),
    ).toHaveLength(0);
    await f.orchestrator.renew(f.run.runId, token, true);
    const entries = await f.store.claimPendingOutbox({
      limit: 20,
      now,
      leaseExpiresAt: '2026-11-04T10:01:00Z',
    });
    expect(
      entries.filter((entry) => entry.kind === 'publish-issue-start'),
    ).toHaveLength(1);
    await publishLinearState(f.store, f.run.runId, 'started', f.fetchImpl);
    expect(f.writes).toEqual([{ id: issueId, input: { stateId: started } }]);
    await f.orchestrator.renew(f.run.runId, token, true);
    expect(
      (
        await f.store.claimPendingOutbox({
          limit: 20,
          now,
          leaseExpiresAt: '2026-11-04T10:01:00Z',
        })
      ).filter((entry) => entry.kind === 'publish-issue-start'),
    ).toHaveLength(0);
  });
  it('never marks delivery complete for a successful execution without protected merge evidence', async () => {
    const f = await fixture();
    await f.orchestrator.confirmDispatch(f.run.runId);
    await f.orchestrator.report(f.run.runId, {
      ok: true,
      summary: 'done',
      ref: 'https://github.com/owner/repo/pull/7',
    });
    await publishLinearState(f.store, f.run.runId, 'completed', f.fetchImpl);
    expect(f.writes).toEqual([]);
  });
  it('preserves human closure and ignores old generations', async () => {
    const f = await fixture();
    f.current.closed = true;
    await publishLinearState(f.store, f.run.runId, 'started', f.fetchImpl);
    expect(f.writes).toEqual([]);
    f.current.closed = false;
    await f.orchestrator.confirmDispatch(f.run.runId);
    await f.orchestrator.report(f.run.runId, { ok: false, summary: 'failed' });
    await f.orchestrator.request({
      taskId: f.taskId,
      requestId: 'next',
      pipeline: 'codex',
      params: { mode: 'reply' },
    });
    await publishLinearState(f.store, f.run.runId, 'failed', f.fetchImpl);
    expect(f.writes).toEqual([]);
  });
  it('fences a human close observed during workflow-state lookup', async () => {
    const f = await fixture();
    const transport = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (url, init) => {
      const request = JSON.parse(init?.body as string);
      const response = await transport(url, init);
      if (request.query.includes('query LcarsWorkflowState'))
        await f.orchestrator.refreshIssue(f.taskId, {
          ...issue,
          state: 'closed',
          updatedAt: '2026-11-04T10:00:01.000Z',
        });
      return response;
    });
    await publishLinearState(f.store, f.run.runId, 'started', f.fetchImpl);
    expect(f.writes).toEqual([]);
  });
  it('keeps wrong-team and terminal non-delivery mappings retryably invalid', async () => {
    const f = await fixture();
    f.current.stateTeam = org;
    await expect(
      publishLinearState(f.store, f.run.runId, 'started', f.fetchImpl),
    ).rejects.toThrow('team/category');
    f.current.stateTeam = team;
    f.current.category = 'completed';
    await expect(
      publishLinearState(f.store, f.run.runId, 'started', f.fetchImpl),
    ).rejects.toThrow('team/category');
    expect(f.writes).toEqual([]);
  });
});
