import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { afterEach, describe, expect, it } from 'vitest';

import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { attemptTaggedReplyResume } from './tagged-reply-resume';

const REPO = 'jlapenna/agent-lcars';
const NOW = '2026-09-06T00:00:00.000Z';
const ISSUE = 42;
const MAX_LIVE_RUNS_VAR = 'AGENT_LCARS_WORK_MAX_LIVE_RUNS';

const spec = {
  title: 'Investigate the flaky test',
  description: 'It fails on CI only.',
  pipeline: 'claude',
  target: { repo: REPO },
};

afterEach(() => {
  delete process.env[MAX_LIVE_RUNS_VAR];
});

function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  const deps: OrchestratorRouteDeps = {
    store,
    orchestrator,
    drain: async () => ({ dispatched: [], reported: [], failed: [] }),
  };
  return { store, orchestrator, deps };
}

/** Admits `{ repo: REPO, issue: ISSUE }` with one finished, parked run --
 *  the precondition every "resumes" case below shares. */
async function parkTask(orchestrator: Orchestrator): Promise<void> {
  const outcome = await orchestrator.request({
    taskId: { repo: REPO, issue: ISSUE },
    requestId: 'first',
    pipeline: 'claude',
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec,
    },
  });
  if (isRefusal(outcome)) throw new Error('unexpected refusal in fixture');
  await orchestrator.report(decidedRun(outcome).runId, {
    ok: true,
    summary: 'park',
  });
}

/** Same as `parkTask`, but the run finishes ordinarily (`done`, not
 *  `parked`) -- the other anchor state the behavior table says a tagged
 *  reply must resume. */
async function finishTask(orchestrator: Orchestrator): Promise<void> {
  const outcome = await orchestrator.request({
    taskId: { repo: REPO, issue: ISSUE },
    requestId: 'first',
    pipeline: 'claude',
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec,
    },
  });
  if (isRefusal(outcome)) throw new Error('unexpected refusal in fixture');
  await orchestrator.report(decidedRun(outcome).runId, { ok: true });
}

function delivery(overrides: {
  action?: string;
  body?: string;
  htmlUrl?: string | null;
}) {
  return {
    event: 'issue_comment',
    pipeline: 'claude' as const,
    deliveryId: 'delivery-1',
    payload: {
      action: overrides.action ?? 'created',
      repository: { full_name: REPO },
      issue: { number: ISSUE, title: 'Issue title', body: 'Issue body' },
      comment: {
        body: overrides.body ?? '@claude Use Firestore.',
        author_association: 'MEMBER',
        ...(overrides.htmlUrl === null
          ? {}
          : {
              html_url:
                overrides.htmlUrl ??
                `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-1`,
            }),
      },
      sender: { login: 'jlapenna' },
    },
  };
}

describe('attemptTaggedReplyResume', () => {
  it('resumes the session when a tagged comment lands on a parked anchor', async () => {
    const { orchestrator, deps, store } = fixture();
    await parkTask(orchestrator);

    const result = await attemptTaggedReplyResume(deps, delivery({}));

    expect(result).toMatchObject({ status: 200 });
    expect(result?.body['runId']).toBeDefined();
    const runs = await store.listRuns({ repo: REPO, issue: ISSUE });
    expect(runs.at(-1)?.params).toMatchObject({
      mode: 'reply',
      reply: '@claude Use Firestore.',
      replyChannel: 'github',
      replyPrincipal: 'github:jlapenna',
    });
  });

  it('resumes the session when a tagged comment lands on a DONE anchor', async () => {
    const { orchestrator, deps } = fixture();
    await finishTask(orchestrator);

    const result = await attemptTaggedReplyResume(deps, delivery({}));

    expect(result).toMatchObject({ status: 200 });
    expect(result?.body['runId']).toBeDefined();
  });

  it('falls through (undefined) when the anchor has no task at all -- NOT_FOUND', async () => {
    const { deps } = fixture();

    expect(await attemptTaggedReplyResume(deps, delivery({}))).toBeUndefined();
  });

  it('falls through (undefined) when the anchor is still running -- CONFLICT/task-busy, no second run', async () => {
    const { orchestrator, deps, store } = fixture();
    // Requested but never reported -> the task stays 'running'.
    await orchestrator.request({
      taskId: { repo: REPO, issue: ISSUE },
      requestId: 'first',
      pipeline: 'claude',
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec,
      },
    });

    expect(await attemptTaggedReplyResume(deps, delivery({}))).toBeUndefined();
    expect(await store.listRuns({ repo: REPO, issue: ISSUE })).toHaveLength(1);
  });

  it('falls through (undefined) when the anchor is canceled -- CONFLICT/task-closed', async () => {
    const { orchestrator, deps } = fixture();
    const outcome = await orchestrator.request({
      taskId: { repo: REPO, issue: ISSUE },
      requestId: 'first',
      pipeline: 'claude',
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec,
      },
    });
    if (isRefusal(outcome)) throw new Error('unexpected refusal in fixture');
    await orchestrator.cancel(decidedRun(outcome).runId);

    expect(await attemptTaggedReplyResume(deps, delivery({}))).toBeUndefined();
  });

  it('falls through (undefined) when the fleet is at its live-run cap -- TOO_MANY_REQUESTS', async () => {
    const { orchestrator, deps } = fixture();
    await parkTask(orchestrator);
    process.env[MAX_LIVE_RUNS_VAR] = '1';
    // Fills the one native (workId-anchored) slot the cap counts --
    // `liveNativeRunCount` only counts native work, never a GitHub anchor
    // like `ISSUE` above, so this is the only way to reach the cap here.
    const filling = await orchestrator.request({
      taskId: { workId: 'w1' },
      requestId: 'fill-cap',
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'console' },
        spec,
      },
    });
    if (isRefusal(filling)) throw new Error('unexpected refusal in fixture');

    expect(await attemptTaggedReplyResume(deps, delivery({}))).toBeUndefined();
  });

  it('falls through (undefined) for a non-issue_comment event', async () => {
    const { deps } = fixture();

    expect(
      await attemptTaggedReplyResume(deps, {
        event: 'issues',
        deliveryId: 'd1',
        pipeline: 'claude',
        payload: {},
      }),
    ).toBeUndefined();
  });

  it('falls through (undefined) for a malformed payload', async () => {
    const { deps } = fixture();

    expect(
      await attemptTaggedReplyResume(deps, {
        event: 'issue_comment',
        deliveryId: 'd1',
        pipeline: 'claude',
        payload: { not: 'a valid comment payload' },
      }),
    ).toBeUndefined();
  });
});
