import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { afterEach, describe, expect, it } from 'vitest';

import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { handlePushWebhookDelivery, pushDeliveryItemId } from './push-watch';

const REPO = 'jlapenna/repo-tools';
const TARGET_REPO = 'jlapenna/homelab';
const SHA = 'a'.repeat(40);
const COMMIT_TIME = '2026-09-01T12:00:00.000Z';

const GRANT = JSON.stringify([
  {
    principal: 'svc:push-watch',
    subjects: ['push-watch'],
    pipelines: ['claude'],
    scopes: ['work.operator'],
  },
]);

const VARS = [
  'AGENT_LCARS_PUSH_WATCHED_REPOS',
  'AGENT_LCARS_PUSH_WATCH_TARGET_REPO',
  'AGENT_LCARS_WORK_GRANTS',
  'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
  'AGENT_LCARS_WATCHED_REPOS',
] as const;

afterEach(() => {
  for (const key of VARS) delete process.env[key];
});

function watchedEnv() {
  process.env['AGENT_LCARS_PUSH_WATCHED_REPOS'] = REPO;
  process.env['AGENT_LCARS_PUSH_WATCH_TARGET_REPO'] = TARGET_REPO;
  process.env['AGENT_LCARS_WORK_GRANTS'] = GRANT;
  // isControlPlaneRepository() is unrelated to the push-watch gate, but
  // forbiddenReason() (called inside mintItem) checks it against the work
  // item's *target* repo, which is always TARGET_REPO -- see deployment.ts.
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] = TARGET_REPO;
  process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
    { owner: 'jlapenna', name: 'homelab' },
  ]);
}

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'refs/heads/main',
    after: SHA,
    repository: { full_name: REPO },
    head_commit: { id: SHA, timestamp: COMMIT_TIME },
    ...overrides,
  };
}

function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => COMMIT_TIME,
  });
  const deps: OrchestratorRouteDeps = {
    store,
    orchestrator,
    drain: async () => ({ dispatched: [], reported: [], failed: [] }),
  };
  return { store, deps };
}

describe('pushDeliveryItemId', () => {
  it('is deterministic for the same repo/sha/commit time', async () => {
    const a = await pushDeliveryItemId(REPO, SHA, new Date(COMMIT_TIME));
    const b = await pushDeliveryItemId(REPO, SHA, new Date(COMMIT_TIME));
    expect(a).toBe(b);
    expect(a).toHaveLength(26);
  });

  it('differs for a different sha', async () => {
    const a = await pushDeliveryItemId(REPO, SHA, new Date(COMMIT_TIME));
    const b = await pushDeliveryItemId(
      REPO,
      'b'.repeat(40),
      new Date(COMMIT_TIME),
    );
    expect(a).not.toBe(b);
  });
});

describe('handlePushWebhookDelivery', () => {
  it('ignores a push from a repository that is not push-watched', async () => {
    process.env['AGENT_LCARS_WORK_GRANTS'] = GRANT;
    const { deps, store } = fixture();
    const result = await handlePushWebhookDelivery(deps, {
      deliveryId: 'd1',
      payload: pushPayload(),
    });
    expect(result.status).toBe(200);
    expect(result.body['ignored']).toBeDefined();
    expect((await store.listLiveRuns()).length).toBe(0);
  });

  it('ignores a push to a non-main ref', async () => {
    watchedEnv();
    const { deps } = fixture();
    const result = await handlePushWebhookDelivery(deps, {
      deliveryId: 'd1',
      payload: pushPayload({ ref: 'refs/heads/feature' }),
    });
    expect(result.body['ignored']).toBeDefined();
  });

  it('ignores a branch-delete push (no head_commit)', async () => {
    watchedEnv();
    const { deps } = fixture();
    const result = await handlePushWebhookDelivery(deps, {
      deliveryId: 'd1',
      payload: pushPayload({
        after: '0'.repeat(40),
        head_commit: null,
      }),
    });
    expect(result.body['ignored']).toBeDefined();
  });

  it('mints a native work item targeting the fixed repo on a watched main push', async () => {
    watchedEnv();
    const { deps, store } = fixture();
    const id = await pushDeliveryItemId(REPO, SHA, new Date(COMMIT_TIME));

    const result = await handlePushWebhookDelivery(deps, {
      deliveryId: 'd1',
      payload: pushPayload(),
    });

    expect(result.status).toBe(200);
    expect(result.body['workId']).toBe(id);
    expect(result.body['existing']).toBe(false);

    const task = await store.readTask({ workId: id });
    expect(task).toBeDefined();
    const work = task?.task.work as {
      spec: { target: { repo: string }; pipeline: string; title: string };
    };
    expect(work.spec.target.repo).toBe(TARGET_REPO);
    expect(work.spec.pipeline).toBe('claude');
    expect(work.spec.title).toContain(SHA.slice(0, 12));
  });

  it('is idempotent for a redelivery of the same push', async () => {
    watchedEnv();
    const { deps, store } = fixture();

    await handlePushWebhookDelivery(deps, {
      deliveryId: 'd1',
      payload: pushPayload(),
    });
    const second = await handlePushWebhookDelivery(deps, {
      deliveryId: 'd2',
      payload: pushPayload(),
    });

    expect(second.body['existing']).toBe(true);
    expect((await store.listLiveRuns()).length).toBe(1);
  });

  it('refuses cleanly when no grant is configured for the principal', async () => {
    process.env['AGENT_LCARS_PUSH_WATCHED_REPOS'] = REPO;
    process.env['AGENT_LCARS_PUSH_WATCH_TARGET_REPO'] = TARGET_REPO;
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] = TARGET_REPO;
    process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
      { owner: 'jlapenna', name: 'homelab' },
    ]);
    // No AGENT_LCARS_WORK_GRANTS set.
    const { deps, store } = fixture();

    const result = await handlePushWebhookDelivery(deps, {
      deliveryId: 'd1',
      payload: pushPayload(),
    });

    expect(result.body['refused']).toBeDefined();
    expect((await store.listLiveRuns()).length).toBe(0);
  });
});
