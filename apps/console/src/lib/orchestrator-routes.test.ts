import {
  MemoryStore,
  Orchestrator,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { drainOutbox } from './orchestrator-dispatch';
import {
  handleCompletion,
  handleReconcile,
  handleWebhookDelivery,
  type OrchestratorRouteDeps,
} from './orchestrator-routes';

// No env vars are set in this test environment, so `controlPlaneRepository()`
// falls back to this deployment's default -- see deployment.ts/.test.ts.
const REPO = 'jlapenna/agent-lcars';
const ISSUE: TaskId = { repo: REPO, issue: 42 };
const T0 = '2026-08-15T12:00:00.000Z';
const TOKEN = 'gh-test-token-0123456789';

class Clock {
  constructor(private value: string) {}
  now(): string {
    return this.value;
  }
  advanceMinutes(minutes: number): void {
    this.value = new Date(
      Date.parse(this.value) + minutes * 60_000,
    ).toISOString();
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Dispatch (`/actions/workflows/...`) succeeds with 204, an outcome
 *  comment (`/issues/.../comments`) succeeds with 201 -- matching what
 *  `drainOutbox` (orchestrator-dispatch.ts) expects from each endpoint. */
function fakeFetch(
  overrides: {
    dispatchStatus?: number;
    commentStatus?: number;
  } = {},
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const { dispatchStatus = 204, commentStatus = 201 } = overrides;
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const status = url.includes('/actions/workflows/')
      ? dispatchStatus
      : commentStatus;
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function fixture(overrides?: Parameters<typeof fakeFetch>[0]) {
  const clock = new Clock(T0);
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, clock);
  const { fetchImpl, calls } = fakeFetch(overrides);
  const deps: OrchestratorRouteDeps = {
    store,
    orchestrator,
    drain: () =>
      drainOutbox({ store, orchestrator, githubToken: TOKEN, fetchImpl }),
  };
  return { clock, store, orchestrator, deps, calls };
}

function labeledIssuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    repository: { full_name: REPO },
    issue: { number: ISSUE.issue },
    label: { name: 'agent:claude' },
    ...overrides,
  };
}

/** Drives a full label-delivery -> request -> dispatch cycle and returns the
 *  resulting runId, for tests that need an already-running run to build on. */
async function dispatchedRun(
  deps: OrchestratorRouteDeps,
  deliveryId = 'delivery-1',
): Promise<string> {
  const result = await handleWebhookDelivery(deps, {
    event: 'issues',
    deliveryId,
    payload: labeledIssuePayload(),
  });
  return result.body['runId'] as string;
}

describe('handleWebhookDelivery', () => {
  it('ignores a delivery with no trigger label', async () => {
    const { deps } = fixture();
    const result = await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'delivery-1',
      payload: labeledIssuePayload({ label: { name: 'bug' } }),
    });
    expect(result).toEqual({
      status: 200,
      body: { ignored: 'no-trigger-label' },
    });
  });

  it('creates and dispatches a run for a trigger-label delivery', async () => {
    const { deps, calls, store } = fixture();

    const result = await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'delivery-1',
      payload: labeledIssuePayload(),
    });

    expect(result.status).toBe(200);
    const runId = result.body['runId'] as string;
    expect(runId).toBe(`${REPO}#42/r1`);
    expect(result.body['dispatched']).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/${REPO}/actions/workflows/claude.yml/dispatches`,
    );

    const run = await store.readRun(runId);
    expect(run?.state).toBe('running'); // confirmed by the drain
  });

  it('treats a redelivery of the same deliveryId as a duplicate, no second run', async () => {
    const { deps, calls } = fixture();
    const first = await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'delivery-1',
      payload: labeledIssuePayload(),
    });
    calls.length = 0;

    const second = await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'delivery-1',
      payload: labeledIssuePayload(),
    });

    expect(second).toEqual({
      status: 200,
      body: { duplicate: true, runId: first.body['runId'] },
    });
    expect(calls).toHaveLength(0); // no second dispatch attempt
  });

  it('refuses a second different delivery while the task is busy, still one run', async () => {
    const { deps, calls, store } = fixture();
    await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'delivery-1',
      payload: labeledIssuePayload(),
    });
    calls.length = 0;

    const second = await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'delivery-2',
      payload: labeledIssuePayload(),
    });

    expect(second).toEqual({ status: 200, body: { refused: 'task-busy' } });
    expect(calls).toHaveLength(0);
    expect(await store.listRuns(ISSUE)).toHaveLength(1);
  });
});

describe('handleCompletion', () => {
  it('finishes the run, records the ref URL, and posts an outcome comment', async () => {
    const { deps, calls, store } = fixture();
    const runId = await dispatchedRun(deps);
    calls.length = 0;

    const result = await handleCompletion(deps, {
      issue: ISSUE.issue,
      workflow: 'claude.yml',
      intentId: runId,
      outcome: 'pull-request',
      outcomeReference: { kind: 'pull-request', number: 99 },
    });

    expect(result).toEqual({
      status: 200,
      body: { runId, state: 'finished' },
    });
    const run = await store.readRun(runId);
    expect(run?.state).toBe('finished');
    expect(run?.result).toEqual({
      ok: true,
      summary: 'pull-request',
      ref: `https://github.com/${REPO}/pull/99`,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/${REPO}/issues/${ISSUE.issue}/comments`,
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as { body: string };
    expect(body.body).toContain(runId);
  });

  it('ignores a completion for an unknown intentId', async () => {
    const { deps } = fixture();
    const result = await handleCompletion(deps, {
      issue: ISSUE.issue,
      workflow: 'claude.yml',
      intentId: `${REPO}#42/r99`,
      outcome: 'pull-request',
    });
    expect(result).toEqual({ status: 200, body: { ignored: 'unknown-run' } });
  });

  it('ignores a completion with no intentId', async () => {
    const { deps } = fixture();
    const result = await handleCompletion(deps, {
      issue: ISSUE.issue,
      workflow: 'claude.yml',
    });
    expect(result).toEqual({ status: 200, body: { ignored: 'unknown-run' } });
  });

  it('leaves the recorded result unchanged on a duplicate completion', async () => {
    const { deps, store } = fixture();
    const runId = await dispatchedRun(deps);
    await handleCompletion(deps, {
      issue: ISSUE.issue,
      workflow: 'claude.yml',
      intentId: runId,
      outcome: 'pull-request',
      outcomeReference: { kind: 'pull-request', number: 99 },
    });
    const finishedRun = await store.readRun(runId);

    const second = await handleCompletion(deps, {
      issue: ISSUE.issue,
      workflow: 'claude.yml',
      intentId: runId,
      outcome: 'comment',
    });

    expect(second).toEqual({ status: 200, body: { refused: 'run-not-live' } });
    expect(await store.readRun(runId)).toEqual(finishedRun);
  });
});

describe('handleReconcile', () => {
  it('marks an expired run lost, auto-retries it, dispatches the retry, and drains the outcome comment', async () => {
    const { deps, clock, calls, store } = fixture();
    const runId = await dispatchedRun(deps);
    calls.length = 0;
    clock.advanceMinutes(121); // past the 2-hour lease

    const result = await handleReconcile(deps);

    expect(result.status).toBe(200);
    expect(result.body['lost']).toEqual([runId]);
    const retried = result.body['retried'] as {
      lostRunId: string;
      newRunId: string;
    }[];
    expect(retried).toHaveLength(1);
    expect(retried[0]?.lostRunId).toBe(runId);
    const newRunId = retried[0]?.newRunId as string;
    expect(result.body['dispatched']).toEqual([newRunId]);
    expect(result.body['reported']).toEqual([runId]);

    const run = await store.readRun(runId);
    expect(run?.state).toBe('lost');
    const newRun = await store.readRun(newRunId);
    expect(newRun?.state).toBe('running'); // confirmed by the drain's dispatch
    expect(newRun?.requestId).toBe(`retry:${runId}`);
    expect(newRun?.pipeline).toBe('claude');

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        `https://api.github.com/repos/${REPO}/actions/workflows/claude.yml/dispatches`,
        `https://api.github.com/repos/${REPO}/issues/${ISSUE.issue}/comments`,
      ].sort(),
    );
    const commentCall = calls.find((c) => c.url.includes('/comments'));
    const commentBody = JSON.parse(String(commentCall?.init.body)) as {
      body: string;
    };
    expect(commentBody.body).toContain(newRunId);
    expect(commentBody.body).toContain('attempt 2 of 3');
  });
});

describe('error handling', () => {
  it('turns a thrown store failure into a 500 without throwing', async () => {
    class ThrowingStore extends MemoryStore {
      override async readRun(): Promise<never> {
        throw new Error('store exploded');
      }
    }
    const clock = new Clock(T0);
    const store = new ThrowingStore();
    const orchestrator = new Orchestrator(store, clock);
    const { fetchImpl } = fakeFetch();
    const deps: OrchestratorRouteDeps = {
      store,
      orchestrator,
      drain: () =>
        drainOutbox({ store, orchestrator, githubToken: TOKEN, fetchImpl }),
    };

    const result = await handleCompletion(deps, {
      issue: ISSUE.issue,
      workflow: 'claude.yml',
      intentId: `${REPO}#42/r1`,
      outcome: 'pull-request',
    });

    expect(result).toEqual({ status: 500, body: { error: 'internal' } });
  });
});
