import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { afterEach, describe, expect, it } from 'vitest';

import { handleImplicitReplyDelivery } from './implicit-reply';
import type { OrchestratorRouteDeps } from './orchestrator-routes';

// Matches vitest-setup.ts's default AGENT_LCARS_CONTROL_PLANE_REPOSITORIES
// (and its paired AGENT_LCARS_WATCHED_REPOS), so `forbiddenReason`'s
// repository check clears without extra per-test config.
const REPO = 'jlapenna/agent-lcars';
const NOW = '2026-09-04T00:00:00.000Z';
const ISSUE = 42;

const spec = {
  title: 'Investigate the flaky test',
  description: 'It fails on CI only.',
  pipeline: 'claude',
  target: { repo: REPO },
};

const ENV_VARS = ['AGENT_LCARS_IMPLICIT_REPLY_REPOS'] as const;

afterEach(() => {
  for (const key of ENV_VARS) delete process.env[key];
});

function enabledEnv(): void {
  process.env['AGENT_LCARS_IMPLICIT_REPLY_REPOS'] = REPO;
}

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
 *  the precondition every "replies" case below shares. */
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

function delivery(overrides: {
  action?: string;
  userType?: string;
  authorAssociation?: string;
  body?: string;
}) {
  return {
    event: 'issue_comment',
    deliveryId: 'delivery-1',
    payload: {
      action: overrides.action ?? 'created',
      repository: { full_name: REPO },
      issue: { number: ISSUE, title: 'Issue title', body: 'Issue body' },
      comment: {
        body: overrides.body ?? 'Use Firestore.',
        author_association: overrides.authorAssociation ?? 'MEMBER',
        html_url: `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-1`,
        ...(overrides.userType === undefined
          ? {}
          : { user: { type: overrides.userType } }),
      },
      sender: { login: 'jlapenna' },
    },
  };
}

describe('handleImplicitReplyDelivery', () => {
  it('replies when a member comments on a parked anchor in an enabled repo', async () => {
    enabledEnv();
    const { orchestrator, deps, store } = fixture();
    await parkTask(orchestrator);

    const result = await handleImplicitReplyDelivery(deps, delivery({}));

    expect(result).toMatchObject({ status: 200 });
    expect(result?.body['replied']).toBeDefined();
    const runs = await store.listRuns({ repo: REPO, issue: ISSUE });
    expect(runs.at(-1)?.params).toMatchObject({
      mode: 'reply',
      reply: 'Use Firestore.',
      replyChannel: 'github',
      replyPrincipal: 'github:jlapenna',
    });
  });

  it('ignores a repo that is not on the allowlist', async () => {
    const { orchestrator, deps } = fixture();
    await parkTask(orchestrator);

    expect(
      await handleImplicitReplyDelivery(deps, delivery({})),
    ).toBeUndefined();
  });

  it('ignores a bot comment', async () => {
    enabledEnv();
    const { orchestrator, deps } = fixture();
    await parkTask(orchestrator);

    expect(
      await handleImplicitReplyDelivery(deps, delivery({ userType: 'Bot' })),
    ).toBeUndefined();
  });

  it('ignores a non-member comment', async () => {
    enabledEnv();
    const { orchestrator, deps } = fixture();
    await parkTask(orchestrator);

    expect(
      await handleImplicitReplyDelivery(
        deps,
        delivery({ authorAssociation: 'CONTRIBUTOR' }),
      ),
    ).toBeUndefined();
  });

  it('ignores a comment on a task that is not parked', async () => {
    enabledEnv();
    const { orchestrator, deps } = fixture();
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

    const result = await handleImplicitReplyDelivery(deps, delivery({}));

    expect(result).toMatchObject({
      status: 200,
      body: { ignored: 'task-busy' },
    });
  });

  it('ignores an edited comment action', async () => {
    enabledEnv();
    const { orchestrator, deps } = fixture();
    await parkTask(orchestrator);

    expect(
      await handleImplicitReplyDelivery(deps, delivery({ action: 'edited' })),
    ).toBeUndefined();
  });

  it('ignores a comment on an anchor with no task at all', async () => {
    enabledEnv();
    const { deps } = fixture();

    expect(
      await handleImplicitReplyDelivery(deps, delivery({})),
    ).toBeUndefined();
  });
});
