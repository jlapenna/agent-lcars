import {
  MemoryStore,
  Orchestrator,
  type RequestInput,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import type { DispatchTokenProvider } from './github-app-tokens';
import { drainOutbox } from './orchestrator-dispatch';
import {
  GITHUB_COMMENT_WINDOW_CONTEXT_PREFIX,
  handleReconcile,
  handleWebhookDelivery,
  type OrchestratorRouteDeps,
  ProjectionRefreshError,
} from './orchestrator-routes';

// No env vars are set in this test environment, so `controlPlaneRepository()`
// falls back to this deployment's default -- see deployment.ts/.test.ts.
const REPO = 'jlapenna/agent-lcars';
const ISSUE: TaskId = { repo: REPO, issue: 42 };
const T0 = '2026-08-15T12:00:00.000Z';
const TOKEN = 'gh-test-token-0123456789';
// Trivial fixed-token stub (`AmbientTokenProvider` itself was retired in
// #1284 - see github-app-tokens.ts).
const tokens: DispatchTokenProvider = { tokenFor: async () => TOKEN };
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

/** Outcome comments and issue projections each succeed with 201. */
function fakeFetch(): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

class CallerWinsRetryRaceOrchestrator extends Orchestrator {
  #armed = true;

  override async request(input: RequestInput) {
    if (this.#armed && input.requestSource === 'auto-retry') {
      this.#armed = false;
      await super.request({
        taskId: input.taskId,
        requestId: input.requestId,
        pipeline: input.pipeline,
        ...(input.params === undefined ? {} : { params: input.params }),
        ...(input.work === undefined ? {} : { work: input.work }),
      });
    }
    return super.request(input);
  }
}

function fixture(
  makeOrchestrator: (store: MemoryStore, clock: Clock) => Orchestrator = (
    store,
    clock,
  ) => new Orchestrator(store, clock),
) {
  const clock = new Clock(T0);
  const store = new MemoryStore();
  const orchestrator = makeOrchestrator(store, clock);
  const { fetchImpl, calls } = fakeFetch();
  const deps: OrchestratorRouteDeps = {
    store,
    orchestrator,
    tokens,
    fetchImpl,
    // `now` pins `drainOutbox`'s own clock to `clock` -- the same one
    // stamping entry `createdAt` -- so a fixture built on `T0` never looks
    // stale against the default (real wall-clock) `now` and spuriously
    // trips the anchor-closed check (`isStaleReport` in
    // orchestrator-dispatch.ts).
    drain: () =>
      drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl,
        now: () => clock.now(),
      }),
    refreshGithubAnchorProjection: vi.fn().mockResolvedValue(undefined),
  };
  return { clock, store, orchestrator, deps, calls };
}

function labeledIssuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    repository: { full_name: REPO },
    issue: { number: ISSUE.issue, title: 'Issue title', body: 'Issue body' },
    label: { name: 'agent:claude' },
    ...overrides,
  };
}

function completeIssuePayload(overrides: Record<string, unknown> = {}) {
  return labeledIssuePayload({
    issue: {
      number: ISSUE.issue,
      title: 'Persist this webhook anchor',
      body: 'Queue rendering must read the control-plane projection.',
      html_url: `https://github.com/${REPO}/issues/${ISSUE.issue}`,
      state: 'open',
      updated_at: T0,
      user: { login: 'jlapenna' },
      labels: [{ name: 'bug' }],
      assignees: [],
    },
    label: { name: 'bug' },
    ...overrides,
  });
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
  it('invalidates the queue only after a webhook projection refresh completes', async () => {
    const { deps } = fixture();
    const calls: string[] = [];
    deps.refreshGithubAnchorProjection = vi.fn(async () => {
      calls.push('refresh');
    });
    deps.invalidateAuthoritativeQueue = () => {
      calls.push('invalidate');
    };

    await expect(
      handleWebhookDelivery(deps, {
        event: 'issues',
        deliveryId: 'queue-cache-after-projection',
        payload: completeIssuePayload(),
      }),
    ).resolves.toEqual({
      status: 200,
      body: { ignored: 'no-trigger-label' },
    });
    expect(calls).toEqual(['refresh', 'invalidate']);
  });

  it('uses a complete unassigned delivery as an exact projection refresh signal', async () => {
    const { deps } = fixture();
    const refresh = vi.fn().mockResolvedValue(undefined);
    deps.refreshGithubAnchorProjection = refresh;

    const result = await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'anchor-only-delivery',
      payload: completeIssuePayload(),
    });

    expect(result).toEqual({
      status: 200,
      body: { ignored: 'no-trigger-label' },
    });
    expect(refresh).toHaveBeenCalledWith(ISSUE);
  });

  it('refreshes the affected PR after a submitted or dismissed review', async () => {
    const { deps } = fixture();
    const refresh = vi.fn().mockResolvedValue(undefined);
    deps.refreshGithubAnchorProjection = refresh;

    const result = await handleWebhookDelivery(deps, {
      event: 'pull_request_review',
      deliveryId: 'review-state-delivery',
      payload: {
        action: 'dismissed',
        repository: { full_name: REPO },
        pull_request: { number: ISSUE.issue },
        review: { id: 1234 },
      },
    });

    expect(result).toEqual({
      status: 200,
      body: { ignored: 'unhandled-event' },
    });
    expect(refresh).toHaveBeenCalledWith(ISSUE);
  });

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

  it('keeps a projection-only refresh failure retryable', async () => {
    const { deps } = fixture();
    deps.refreshGithubAnchorProjection = vi
      .fn()
      .mockRejectedValue(new Error('projection store unavailable'));

    await expect(
      handleWebhookDelivery(deps, {
        event: 'issues',
        deliveryId: 'projection-refresh-retry',
        payload: completeIssuePayload(),
      }),
    ).rejects.toMatchObject({
      name: ProjectionRefreshError.name,
      message: 'Projection refresh failed for issues/projection-refresh-retry',
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

    // Queue dispatch stays inside the control plane; GitHub only receives
    // the confirmed dispatch's eyes-reaction/assignee claim projection.
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.url.includes('/actions/workflows/'))).toBe(
      false,
    );
    expect(calls.some((c) => c.url.endsWith(`/issues/42/reactions`))).toBe(
      true,
    );
    expect(calls.some((c) => c.url.endsWith(`/issues/42/assignees`))).toBe(
      true,
    );

    const run = await store.readRun(runId);
    expect(run?.state).toBe('running'); // confirmed by the drain
  });

  it('keeps an admitted trigger-label delivery retryable when projection refresh fails', async () => {
    const { deps, store } = fixture();
    deps.refreshGithubAnchorProjection = vi
      .fn()
      .mockRejectedValue(new Error('projection store unavailable'));

    await expect(
      handleWebhookDelivery(deps, {
        event: 'issues',
        deliveryId: 'admitted-projection-refresh-retry',
        payload: completeIssuePayload({ label: { name: 'agent:claude' } }),
      }),
    ).rejects.toMatchObject({
      name: ProjectionRefreshError.name,
      message:
        'Projection refresh failed after admission for issues/admitted-projection-refresh-retry',
    });
    // The retry is safe: the first admission is already durable and the same
    // delivery id is idempotent in the orchestrator.
    expect(await store.listRuns(ISSUE)).toHaveLength(1);
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

  it('forwards a derived work payload from interpretDelivery to orchestrator.request', async () => {
    const { deps } = fixture();
    const requestSpy = vi.spyOn(deps.orchestrator, 'request');
    await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'd1',
      payload: {
        action: 'labeled',
        repository: { full_name: 'jlapenna/agent-lcars' },
        issue: { number: 1, title: 'T', body: 'B' },
        label: { name: 'agent:claude' },
        sender: { login: 'jlapenna' },
      },
    });
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'T',
            description: 'B',
            pipeline: 'claude',
            target: { repo: 'jlapenna/agent-lcars' },
          },
        },
      }),
    );
  });

  it('gives a later label redispatch a comment window beginning at the previous run', async () => {
    const { clock, deps, store } = fixture();
    const first = await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'first-delivery',
      payload: labeledIssuePayload(),
    });
    const firstRun = await store.readRun(first.body['runId'] as string);
    expect(firstRun?.params).toEqual({ mode: 'implement' });

    await deps.orchestrator.report(firstRun?.runId ?? '', { ok: true });
    clock.advanceMinutes(3);
    const requestSpy = vi.spyOn(deps.orchestrator, 'request');
    await handleWebhookDelivery(deps, {
      event: 'issues',
      deliveryId: 'second-delivery',
      payload: labeledIssuePayload(),
    });

    expect(requestSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: {
          mode: 'implement',
          context: `${GITHUB_COMMENT_WINDOW_CONTEXT_PREFIX}${T0}`,
        },
      }),
    );
  });

  it('does not add a comment window to an initial label dispatch or a reply command', async () => {
    const { deps } = fixture();
    const requestSpy = vi.spyOn(deps.orchestrator, 'request');
    await handleWebhookDelivery(deps, {
      event: 'issue_comment',
      deliveryId: 'reply-delivery',
      payload: {
        action: 'created',
        repository: { full_name: REPO },
        issue: {
          number: ISSUE.issue,
          title: 'Issue title',
          body: 'Issue body',
        },
        comment: {
          body: '@claude continue with the new detail',
          author_association: 'OWNER',
        },
      },
    });

    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          mode: 'reply',
          reply: '@claude continue with the new detail',
        },
      }),
    );
  });

  it('gives a later review-label redispatch the same comment window', async () => {
    const { clock, deps, store } = fixture();
    const reviewPayload = {
      action: 'labeled',
      repository: { full_name: REPO },
      pull_request: {
        number: ISSUE.issue,
        title: 'Pull request title',
        body: 'Pull request body',
      },
      label: { name: 'review:codex' },
    };
    const first = await handleWebhookDelivery(deps, {
      event: 'pull_request',
      deliveryId: 'first-review-delivery',
      payload: reviewPayload,
    });
    const firstRun = await store.readRun(first.body['runId'] as string);
    expect(firstRun?.params).toEqual({ mode: 'review' });

    await deps.orchestrator.report(firstRun?.runId ?? '', { ok: true });
    clock.advanceMinutes(3);
    const requestSpy = vi.spyOn(deps.orchestrator, 'request');
    await handleWebhookDelivery(deps, {
      event: 'pull_request',
      deliveryId: 'second-review-delivery',
      payload: reviewPayload,
    });

    expect(requestSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: {
          mode: 'review',
          context: `${GITHUB_COMMENT_WINDOW_CONTEXT_PREFIX}${T0}`,
        },
      }),
    );
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

    // Queue reconciliation makes no Actions workflow request: only the
    // retry's issue claim projection and the lost run's outcome comment.
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        `https://api.github.com/repos/${REPO}/issues/${ISSUE.issue}/comments`,
        `https://api.github.com/repos/${REPO}/issues/${ISSUE.issue}/reactions`,
        `https://api.github.com/repos/${REPO}/issues/${ISSUE.issue}/assignees`,
      ].sort(),
    );
    expect(calls.some((call) => call.url.includes('/actions/workflows/'))).toBe(
      false,
    );
    const commentCall = calls.find((c) => c.url.includes('/comments'));
    const commentBody = JSON.parse(String(commentCall?.init.body)) as {
      body: string;
    };
    expect(commentBody.body).toContain(newRunId);
    expect(commentBody.body).toContain('attempt 2 of 3');
  });

  it('reports a caller-owned matching replacement as already in progress', async () => {
    const { deps, clock, calls, store } = fixture(
      (currentStore, currentClock) =>
        new CallerWinsRetryRaceOrchestrator(currentStore, currentClock),
    );
    const runId = await dispatchedRun(deps);
    calls.length = 0;
    clock.advanceMinutes(121);

    const result = await handleReconcile(deps);

    expect(result.body['lost']).toEqual([runId]);
    expect(result.body['retried']).toEqual([]);
    const activeRun = await store.readActiveRun(ISSUE);
    expect(activeRun).toMatchObject({
      requestId: `retry:${runId}`,
      requestSource: 'caller',
    });
    const commentCall = calls.find((call) => call.url.includes('/comments'));
    const commentBody = JSON.parse(String(commentCall?.init.body)) as {
      body: string;
    };
    expect(commentBody.body).toContain(
      `Run ${activeRun?.runId} is already in progress.`,
    );
    expect(commentBody.body).not.toContain('Retrying automatically');
  });
});
