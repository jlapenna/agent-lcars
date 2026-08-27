import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
  type Run,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import type { CompletionOidcIdentity } from './github-actions-oidc';
import type { DispatchTokenProvider } from './github-app-tokens';
import { drainOutbox } from './orchestrator-dispatch';
import {
  handleCompletion,
  handleDispatchRequest,
  handleReconcile,
  handleWebhookDelivery,
  type HostedCompletionRequestBody,
  type OrchestratorRouteDeps,
} from './orchestrator-routes';
import { settleTerminalRuns } from './orchestrator-terminal-runs';
import { BindingUnavailable, type RunBinding } from './run-binding';

// No env vars are set in this test environment, so `controlPlaneRepository()`
// falls back to this deployment's default -- see deployment.ts/.test.ts.
const REPO = 'jlapenna/agent-lcars';
const ISSUE: TaskId = { repo: REPO, issue: 42 };
const T0 = '2026-08-15T12:00:00.000Z';
const TOKEN = 'gh-test-token-0123456789';
// Trivial fixed-token stub (`AmbientTokenProvider` itself was retired in
// #1284 - see github-app-tokens.ts).
const tokens: DispatchTokenProvider = { tokenFor: async () => TOKEN };
// A completion caller's verified OIDC identity. Most `handleCompletion`
// tests below stub `deps.bind` (see `completionFixture`), so its exact
// field values are never inspected by the code under test -- only its
// shape matters. The one test that exercises the real default binder (no
// `bind` override) also relies on `repository` matching `REPO` so
// `bindCompletionToRun` gets past its own repo pre-check to the fetch.
const IDENTITY: CompletionOidcIdentity = {
  repository: REPO,
  repositoryId: 1,
  runId: 987_654_321,
  workflow: 'claude.yml',
};

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

/** Dispatch (`/actions/workflows/.../dispatches`) succeeds with 204, an
 *  outcome comment (`/issues/.../comments`) succeeds with 201 -- matching
 *  what `drainOutbox` (orchestrator-dispatch.ts) expects from each endpoint.
 *  The workflow-runs listing (`/actions/workflows/.../runs?...`, read by
 *  `settleTerminalRuns`) serves `workflowRuns`, empty unless a test arms it,
 *  so the reconcile route's terminal probe runs for real here. A single
 *  Actions run lookup (`/actions/runs/<id>`, read by `bindCompletionToRun`
 *  through `defaultBind` -- see `run-binding.ts`) serves `actionsRun`,
 *  `{}` (no marker) unless a test arms it. */
function fakeFetch(
  overrides: {
    dispatchStatus?: number;
    commentStatus?: number;
    workflowRuns?: () => unknown[];
    actionsRun?: () => unknown;
  } = {},
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const { dispatchStatus = 204, commentStatus = 201 } = overrides;
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes('/runs?event=workflow_dispatch')) {
      return new Response(
        JSON.stringify({ workflow_runs: overrides.workflowRuns?.() ?? [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (/\/actions\/runs\/\d+$/u.test(url)) {
      return new Response(JSON.stringify(overrides.actionsRun?.() ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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
    tokens,
    fetchImpl,
    drain: () => drainOutbox({ store, orchestrator, tokens, fetchImpl }),
    settleTerminal: () =>
      settleTerminalRuns({ store, orchestrator, tokens, fetchImpl }),
  };
  return { clock, store, orchestrator, deps, calls };
}

/** `fixture()` plus completion-specific helpers: a stubbed `bind` (most
 *  `handleCompletion` tests below drive the binding decision explicitly
 *  rather than exercising the real GitHub-fetch `bindCompletionToRun` --
 *  that function has its own coverage in `run-binding.test.ts`; one test
 *  deliberately uses bare `fixture()` instead, to prove the *default*
 *  binder is wired), and two ways to seed a run to complete -- a
 *  dispatched GitHub-anchored run (`seedRun`) and an undispatched
 *  native/work-anchored one (`seedNativeRun`, live the moment it's
 *  requested since a live run can report from `pending` just as well as
 *  `running`). */
function completionFixture(
  overrides: { bind?: OrchestratorRouteDeps['bind'] } = {},
) {
  const base = fixture();
  const deps: OrchestratorRouteDeps = {
    ...base.deps,
    bind:
      overrides.bind ?? (async (): Promise<RunBinding> => ({ bound: true })),
  };
  return {
    ...base,
    deps,
    async seedRun(): Promise<Run> {
      const runId = await dispatchedRun(deps);
      const run = await base.store.readRun(runId);
      if (run === undefined) throw new Error('seedRun: run not found');
      return run;
    },
    async seedNativeRun(): Promise<Run> {
      const taskId: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };
      const outcome = await base.orchestrator.request({
        taskId,
        requestId: 'native-request-1',
        pipeline: 'claude',
        work: { spec: { target: { repo: REPO } } },
      });
      if (isRefusal(outcome)) {
        throw new Error('seedNativeRun: request unexpectedly refused');
      }
      return decidedRun(outcome);
    },
  };
}

/** The completion callback body for a run created by `seedRun()` -- a
 *  GitHub-anchored run at the fixed `ISSUE`. */
function completionBody(
  run: Run,
  overrides: Partial<HostedCompletionRequestBody> = {},
): HostedCompletionRequestBody {
  return {
    workflow: 'claude.yml',
    issue: ISSUE.issue,
    intentId: run.runId,
    outcome: 'pull-request',
    outcomeReference: { kind: 'pull-request', number: 99 },
    ...overrides,
  };
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
});

describe('handleDispatchRequest', () => {
  it('creates and dispatches a run, forwarding runbook/context to the worker', async () => {
    const { deps, calls, store } = fixture();

    const result = await handleDispatchRequest(deps, {
      repository: REPO,
      callerRunId: 555,
      body: {
        issue: ISSUE.issue,
        pipeline: 'claude',
        runbook: 'pr-heal',
        context: 'nightly sweep',
      },
    });

    expect(result.status).toBe(200);
    const runId = result.body['runId'] as string;
    expect(runId).toBe(`${REPO}#42/r1`);
    expect(result.body['dispatched']).toBe(true);

    const dispatchCall = calls.find((c) =>
      c.url.includes('/actions/workflows/'),
    );
    const inputs = JSON.parse(String(dispatchCall?.init.body)) as {
      inputs: Record<string, string>;
    };
    expect(inputs.inputs.runbook).toBe('pr-heal');
    expect(inputs.inputs.context).toBe('nightly sweep');

    const run = await store.readRun(runId);
    expect(run?.params).toEqual({
      runbook: 'pr-heal',
      context: 'nightly sweep',
    });
  });

  it('maps a retried caller (same repo/issue/runbook/run id, no requestId) onto the same run', async () => {
    const { deps, calls } = fixture();
    const body = {
      issue: ISSUE.issue,
      pipeline: 'claude' as const,
      runbook: 'pr-heal',
    };

    const first = await handleDispatchRequest(deps, {
      repository: REPO,
      callerRunId: 555,
      body,
    });
    calls.length = 0;

    const second = await handleDispatchRequest(deps, {
      repository: REPO,
      callerRunId: 555,
      body,
    });

    expect(second).toEqual({
      status: 200,
      body: { duplicate: true, runId: first.body['runId'] },
    });
    expect(calls).toHaveLength(0); // no second dispatch attempt
  });

  it('a different caller run id mints a fresh request, refused as task-busy with the live runId', async () => {
    const { deps, calls } = fixture();
    const first = await handleDispatchRequest(deps, {
      repository: REPO,
      callerRunId: 555,
      body: { issue: ISSUE.issue, pipeline: 'claude', runbook: 'pr-heal' },
    });
    calls.length = 0;

    const second = await handleDispatchRequest(deps, {
      repository: REPO,
      callerRunId: 556, // a new workflow run -> a new default requestId
      body: { issue: ISSUE.issue, pipeline: 'claude', runbook: 'pr-heal' },
    });

    expect(second).toEqual({
      status: 200,
      body: { refused: 'task-busy', runId: first.body['runId'] },
    });
    expect(calls).toHaveLength(0);
  });

  it('honors an explicit requestId over the default digest', async () => {
    const { deps } = fixture();
    const first = await handleDispatchRequest(deps, {
      repository: REPO,
      callerRunId: 555,
      body: {
        issue: ISSUE.issue,
        pipeline: 'claude',
        requestId: 'caller-chosen-key',
      },
    });

    const second = await handleDispatchRequest(deps, {
      repository: REPO,
      callerRunId: 999, // different caller run id, but the explicit key wins
      body: {
        issue: ISSUE.issue,
        pipeline: 'claude',
        requestId: 'caller-chosen-key',
      },
    });

    expect(second).toEqual({
      status: 200,
      body: { duplicate: true, runId: first.body['runId'] },
    });
  });
});

describe('handleCompletion', () => {
  it('finishes the run, records the ref URL, and posts an outcome comment', async () => {
    const { deps, calls, seedRun } = completionFixture();
    const run = await seedRun();
    calls.length = 0;

    const result = await handleCompletion(deps, completionBody(run), IDENTITY);

    expect(result).toEqual({
      status: 200,
      body: { runId: run.runId, state: 'finished' },
    });
    const settled = await deps.store.readRun(run.runId);
    expect(settled?.state).toBe('finished');
    expect(settled?.result).toEqual({
      ok: true,
      summary: 'pull-request',
      ref: `https://github.com/${REPO}/pull/99`,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/${REPO}/issues/${ISSUE.issue}/comments`,
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as { body: string };
    expect(body.body).toContain(run.runId);
  });

  it('ignores a completion for an unknown intentId', async () => {
    const { deps } = completionFixture();
    const result = await handleCompletion(
      deps,
      {
        issue: ISSUE.issue,
        workflow: 'claude.yml',
        intentId: `${REPO}#42/r99`,
        outcome: 'pull-request',
      },
      IDENTITY,
    );
    expect(result).toEqual({ status: 200, body: { ignored: 'unknown-run' } });
  });

  it('ignores a completion with no intentId', async () => {
    const { deps } = completionFixture();
    const result = await handleCompletion(
      deps,
      { issue: ISSUE.issue, workflow: 'claude.yml' },
      IDENTITY,
    );
    expect(result).toEqual({ status: 200, body: { ignored: 'unknown-run' } });
  });

  it('leaves the recorded result unchanged on a duplicate completion', async () => {
    const { deps, seedRun } = completionFixture();
    const run = await seedRun();
    await handleCompletion(deps, completionBody(run), IDENTITY);
    const finishedRun = await deps.store.readRun(run.runId);

    const second = await handleCompletion(
      deps,
      completionBody(run, { outcome: 'comment', outcomeReference: undefined }),
      IDENTITY,
    );

    expect(second).toEqual({ status: 200, body: { refused: 'run-not-live' } });
    expect(await deps.store.readRun(run.runId)).toEqual(finishedRun);
  });

  it('returns 503 and settles nothing when the binding lookup is unavailable', async () => {
    const { deps, seedRun } = completionFixture({
      bind: async () => {
        throw new BindingUnavailable('502');
      },
    });
    const run = await seedRun();

    const result = await handleCompletion(deps, completionBody(run), IDENTITY);

    expect(result.status).toBe(503);
    expect((await deps.store.readRun(run.runId))?.state).toBe('running');
  });

  it('returns 403 and settles nothing when the token is not bound to the run', async () => {
    const { deps, seedRun } = completionFixture({
      bind: async (): Promise<RunBinding> => ({
        bound: false,
        reason: 'marker-mismatch',
      }),
    });
    const run = await seedRun();

    const result = await handleCompletion(deps, completionBody(run), IDENTITY);

    expect(result.status).toBe(403);
    expect((await deps.store.readRun(run.runId))?.state).toBe('running');
  });

  it('with no bind override, falls back to the real binder and returns 403 on a mismatched marker', async () => {
    // No `completionFixture()` here on purpose: `deps.bind` is left unset
    // so `handleCompletion` exercises its own `defaultBind` -> the real
    // `bindCompletionToRun` -- proving the production default is actually
    // wired, not merely present in the type (it could be deleted or
    // replaced with an always-true stub and every other test here would
    // stay green, since they all inject `bind` explicitly).
    const { deps, calls, store } = fixture({
      actionsRun: () => ({
        // A real Actions run, but naming a DIFFERENT run (r99) than the
        // one being completed (r1) -- proves the lookup is keyed on the
        // token's own `identity.runId`/`repo`, not on the caller-supplied
        // `intentId` in the body.
        display_title: `#${ISSUE.issue}: [dispatch:g1:${REPO}#${ISSUE.issue}/r99]`,
      }),
    });
    const runId = await dispatchedRun(deps);
    calls.length = 0;

    const result = await handleCompletion(
      deps,
      {
        workflow: 'claude.yml',
        issue: ISSUE.issue,
        intentId: runId,
        outcome: 'pull-request',
        outcomeReference: { kind: 'pull-request', number: 99 },
      },
      IDENTITY,
    );

    expect(result.status).toBe(403);
    expect((await store.readRun(runId))?.state).toBe('running');
    expect(
      calls.some((c) => c.url.endsWith(`/actions/runs/${IDENTITY.runId}`)),
    ).toBe(true);
  });

  it('settles a native run addressed by runId with no issue in the body', async () => {
    const { deps, seedNativeRun } = completionFixture({
      bind: async (): Promise<RunBinding> => ({ bound: true }),
    });
    const run = await seedNativeRun();

    const result = await handleCompletion(
      deps,
      {
        workflow: 'claude.yml',
        intentId: run.runId,
        outcome: 'pull-request',
        outcomeReference: { kind: 'pull-request', number: 12 },
      },
      IDENTITY,
    );

    expect(result.status).toBe(200);
    const settled = await deps.store.readRun(run.runId);
    expect(settled?.state).toBe('finished');
    expect(settled?.result?.ref).toBe(`https://github.com/${REPO}/pull/12`);
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

    // Three calls: the terminal probe's workflow-runs listing (which found
    // nothing terminal here, so the lease sweep did the settling), then the
    // retry's dispatch and the lost run's outcome comment.
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.url).sort()).toEqual(
      [
        `https://api.github.com/repos/${REPO}/actions/workflows/claude.yml/dispatches`,
        `https://api.github.com/repos/${REPO}/actions/workflows/claude.yml/runs` +
          `?event=workflow_dispatch&per_page=100`,
        `https://api.github.com/repos/${REPO}/issues/${ISSUE.issue}/comments`,
      ].sort(),
    );
    const commentCall = calls.find((c) => c.url.includes('/comments'));
    const commentBody = JSON.parse(String(commentCall?.init.body)) as {
      body: string;
    };
    expect(commentBody.body).toContain(newRunId);
    expect(commentBody.body).toContain('attempt 2 of 3');
    expect(result.body['terminal']).toEqual([]);
  });

  it('settles a run whose workflow run is already terminal, minutes into its lease (#1361)', async () => {
    let terminal: unknown[] = [];
    const { deps, clock, calls, store } = fixture({
      workflowRuns: () => terminal,
    });
    const runId = await dispatchedRun(deps);
    terminal = [
      {
        display_title: `#${ISSUE.issue}: Claude issue agent [dispatch:g1:${runId}]`,
        status: 'completed',
        conclusion: 'startup_failure',
      },
    ];
    calls.length = 0;
    // One minute in. The lease has another 119 minutes to run, so before
    // #1361 this whole cycle reported `{lost: [], retried: []}` and the task
    // stayed wedged -- exactly the girosf#15 symptom.
    clock.advanceMinutes(1);

    const result = await handleReconcile(deps);

    expect(result.status).toBe(200);
    expect(result.body['lost']).toEqual([]); // nothing expired: not the sweep
    expect(result.body['terminal']).toEqual([
      { runId, conclusion: 'startup_failure' },
    ]);
    const retried = result.body['retried'] as {
      lostRunId: string;
      newRunId: string;
    }[];
    expect(retried).toHaveLength(1);
    expect(retried[0]?.lostRunId).toBe(runId);
    const newRunId = retried[0]?.newRunId as string;
    // Released AND re-dispatched inside this one reconcile cycle.
    expect(result.body['dispatched']).toEqual([newRunId]);
    expect((await store.readRun(runId))?.state).toBe('lost');
    expect((await store.readRun(newRunId))?.state).toBe('running');
    expect((await store.readActiveRun(ISSUE))?.runId).toBe(newRunId);
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
      tokens,
      fetchImpl,
      drain: () => drainOutbox({ store, orchestrator, tokens, fetchImpl }),
      settleTerminal: () =>
        settleTerminalRuns({ store, orchestrator, tokens, fetchImpl }),
    };

    const result = await handleCompletion(
      deps,
      {
        issue: ISSUE.issue,
        workflow: 'claude.yml',
        intentId: `${REPO}#42/r1`,
        outcome: 'pull-request',
      },
      IDENTITY,
    );

    expect(result).toEqual({ status: 500, body: { error: 'internal' } });
  });
});
