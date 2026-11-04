// @vitest-environment node
import type { TriageAnchor } from '@agent-lcars/dispatch-contracts';
import {
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./cli-sessions', () => ({
  getCliSessions: async () => ({ sessions: [], warnings: [] }),
}));
vi.mock('./work-sessions', () => ({ sessionsForRuns: async () => [] }));
vi.mock('./github-client', () => ({ getGithubClient: () => ({}) }));
import { publishFleetTriage } from './fleet-triage-publish';
import { triageEligible, triageSourceKey } from './fleet-triage-source';
import { admitFleetTriage } from './fleet-triage-work';
import { loadLinearTriageSource } from './linear-triage-source';
const org = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const bug = '33333333-3333-4333-8333-333333333333';
const issueId = '44444444-4444-4444-8444-444444444444';
const ready = '55555555-5555-4555-8555-555555555555';
const metadata = '66666666-6666-4666-8666-666666666666';
const anchor: Extract<TriageAnchor, { source: unknown }> = {
  repo: 'owner/repo',
  source: { tracker: 'linear', organizationId: org, issueId },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'));
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
          triage: {
            bugLabelIds: [bug],
            readyLabelId: ready,
            pipeline: 'codex',
            principal: 'svc:linear',
          },
        },
      ],
      routes: [
        {
          teamId: team,
          labelId: ready,
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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => new Date().toISOString(),
  });
  const labels = [{ id: bug, name: 'Bug' }];
  const comments: {
    id: string;
    body: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    user: null;
    issue: { id: string };
  }[] = [];
  const effects: string[] = [];
  let assigned = false;
  const issue = () => ({
    id: issueId,
    identifier: 'ENG-42',
    title: 'Search defect',
    description: 'Reproduce missing search result',
    url: 'https://linear.app/example/issue/ENG-42',
    updatedAt: '2026-11-04T10:00:00.000Z',
    team: { id: team },
    state: { id: team, name: 'Backlog', type: 'backlog' },
    assignee: assigned ? { id: org, name: 'Joe' } : null,
    labels: { nodes: labels, pageInfo: { hasNextPage: false } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_url, init) => {
      const { query, variables } = JSON.parse(init?.body as string);
      let data;
      if (query.includes('LcarsIssue('))
        data = { organization: { id: org }, issue: issue() };
      else if (query.includes('LcarsIssueComments'))
        data = {
          issue: {
            comments: {
              nodes: comments,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      else if (query.includes('LcarsIssueAttachments'))
        data = {
          issue: {
            attachments: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      else if (query.includes('LcarsLabels'))
        data = {
          issueLabels: {
            nodes: [
              { id: metadata, name: 'component:console', team: { id: team } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      else if (query.includes('LcarsIssueUpdate')) {
        for (const id of variables.input.addedLabelIds ?? []) {
          labels.push({
            id,
            name: id === metadata ? 'component:console' : 'LCARS Codex',
          });
          effects.push(`label:${id}`);
        }
        data = { issueUpdate: { success: true, issue: { id: issueId } } };
      } else if (query.includes('LcarsTrackerComment')) {
        comments.push({
          ...variables.input,
          url: 'https://linear.app/example/comment',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          user: null,
          issue: { id: issueId },
        });
        effects.push('comment');
        data = {
          commentCreate: {
            success: true,
            comment: { id: variables.input.id, issue: { id: issueId } },
          },
        };
      } else if (query.includes('LcarsComment('))
        data = {
          comment:
            comments.find((comment) => comment.id === variables.id) ?? null,
        };
      else if (query.includes('LcarsTriageHistory'))
        data = {
          issue: {
            history: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      else throw new Error('Unexpected Linear triage operation');
      return Response.json({ data });
    }),
  );
  return {
    store,
    orchestrator,
    labels,
    comments,
    effects,
    assign: () => {
      assigned = true;
    },
  };
}
async function completed(
  f: ReturnType<typeof fixture>,
  disposition = 'ready',
  target = anchor,
) {
  await admitFleetTriage(f, target);
  const workId = await f.store.readSourceWorkId(triageSourceKey(target));
  const run = (await f.store.listRuns({ workId: workId! }))[0]!;
  await f.orchestrator.confirmDispatch(run.runId);
  const result = await f.orchestrator.report(
    run.runId,
    {
      ok: true,
      summary: 'report',
      message: JSON.stringify({
        sourceRevision: run.sourceRevision!.key,
        disposition,
        summary: 'Confirmed source defect',
        evidence: ['Search handler omits the result'],
        acceptanceCriteria: ['Returns the matching result'],
        labels: ['component:console'],
      }),
    },
    undefined,
    undefined,
    undefined,
    true,
  );
  if (isRefusal(result)) throw new Error(result.reason);
  const entry = (
    await f.store.claimPendingOutbox({
      limit: 20,
      now: new Date().toISOString(),
      leaseExpiresAt: '2026-11-04T10:05:00.000Z',
    })
  ).find((entry) => entry.kind === 'publish-triage')!;
  return { run, entry };
}
describe('Linear event-driven triage', () => {
  it('uses UUID source context and the configured analysis pipeline for an unowned bug', async () => {
    const f = fixture();
    const source = await loadLinearTriageSource(f.store, anchor);
    expect(triageEligible(source)).toBe(true);
    await admitFleetTriage(f, anchor);
    const id = await f.store.readSourceWorkId(triageSourceKey(anchor));
    const run = (await f.store.listRuns({ workId: id! }))[0]!;
    expect(run.pipeline).toBe('codex');
    expect(run.issue?.reference).toEqual(anchor.source);
    expect(run.sourceRevision?.input).toMatchObject({
      source: anchor.source,
      repo: 'owner/repo',
    });
    expect(run.sourceRevision?.input).not.toHaveProperty('issue');
    f.assign();
    expect(triageEligible(await loadLinearTriageSource(f.store, anchor))).toBe(
      false,
    );
  });
  it('publishes metadata, a UUID comment and one configured ready route through shared receipts', async () => {
    const f = fixture();
    const { run, entry } = await completed(f);
    await publishFleetTriage(f.store, entry);
    expect(f.effects).toEqual([
      `label:${metadata}`,
      'comment',
      `label:${ready}`,
    ]);
    expect((await f.store.readRun(run.runId))?.triagePublication).toMatchObject(
      {
        state: 'complete',
        dispatchObserved: true,
        commentId: expect.any(String),
      },
    );
    await publishFleetTriage(f.store, entry);
    expect(f.comments).toHaveLength(1);
  });
  it('publishes the ready label for the actual repository in a shared team', async () => {
    const f = fixture();
    const repositoryLabel = '77777777-7777-4777-8777-777777777777';
    const readyOther = '88888888-8888-4888-8888-888888888888';
    const config = JSON.parse(process.env['AGENT_LCARS_LINEAR']!);
    delete config.teams[0].repo;
    config.teams[0].repositories = [
      { repo: 'owner/other', labelId: repositoryLabel },
    ];
    config.routes.push({
      ...config.routes[0],
      labelId: readyOther,
      repo: 'owner/other',
    });
    vi.stubEnv('AGENT_LCARS_LINEAR', JSON.stringify(config));
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
    f.labels.push({ id: repositoryLabel, name: 'Repository: other' });
    const target = { ...anchor, repo: 'owner/other' };
    const source = await loadLinearTriageSource(f.store, target);
    expect(source.dispatchLabel).toBe(readyOther);
    expect(triageEligible(source)).toBe(true);
    const { entry } = await completed(f, 'ready', target);
    await publishFleetTriage(f.store, entry);
    expect(f.effects).toEqual([
      `label:${metadata}`,
      'comment',
      `label:${readyOther}`,
    ]);
    expect(f.labels.some((label) => label.id === ready)).toBe(false);
  });
  it('publishes needs-owner evidence without coding dispatch', async () => {
    const f = fixture();
    const { entry } = await completed(f, 'needs-owner');
    await publishFleetTriage(f.store, entry);
    expect(f.effects).toEqual([`label:${metadata}`, 'comment']);
    expect(f.comments[0]?.body).toContain('needs-owner');
  });
});
