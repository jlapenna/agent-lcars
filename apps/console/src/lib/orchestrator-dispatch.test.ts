import {
  decidedRun,
  expireLease,
  isRefusal,
  MAX_AUTO_RETRIES,
  MemoryStore,
  Orchestrator,
  OUTBOX_LEASE_MS,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import type { DispatchTokenProvider } from './github-app-tokens';
import { drainOutbox } from './orchestrator-dispatch';

const TASK: TaskId = { repo: 'octo/example', issue: 7 };
const T0 = '2026-08-15T12:00:00.000Z';
const TOKEN = 'gh-test-token-0123456789';
// `DispatchDeps.tokens` resolves a per-repo token; every test here still
// wants the exact-same-token-for-any-repo behavior the old
// `githubToken: TOKEN` field gave directly, so a trivial fixed-token stub
// reproduces it (`AmbientTokenProvider` itself was retired in #1284 - see
// github-app-tokens.ts).
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

function fixture() {
  const clock = new Clock(T0);
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, clock);
  return { clock, store, orchestrator };
}

async function started(
  orchestrator: Orchestrator,
  requestId = 'req-1',
  params?: Record<string, string>,
) {
  const outcome = await orchestrator.request({
    taskId: TASK,
    requestId,
    pipeline: 'claude',
    ...(params === undefined ? {} : { params }),
  });
  if (isRefusal(outcome)) {
    throw new Error(`unexpected refusal: ${outcome.reason}`);
  }
  return outcome;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function callBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** A URL-aware fake fetch: dispatch calls (`/actions/workflows/...`)
 *  succeed with 204, comment and label calls succeed with 201/200 -- so a
 *  single drain that both dispatches an auto-retry and posts an outcome
 *  comment (or a needs-human label) doesn't need multiple fixtures. */
function routedFetch(
  overrides: {
    dispatchStatus?: number;
    commentStatus?: number;
    labelStatus?: number;
  } = {},
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const {
    dispatchStatus = 204,
    commentStatus = 201,
    labelStatus = 200,
  } = overrides;
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const status = url.includes('/actions/workflows/')
      ? dispatchStatus
      : url.endsWith('/labels')
        ? labelStatus
        : commentStatus;
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('drainOutbox: dispatch-run', () => {
  it('dispatches a pending run and confirms it', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    const { fetchImpl, calls } = fakeFetch(204);

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    // workflow_dispatch + the confirmed dispatch's eyes-reaction/assignee
    // projection (see the dedicated tests below).
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/octo/example/actions/workflows/claude.yml/dispatches',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
    });

    const body = callBody(calls[0]!);
    expect(body.ref).toBe('main');
    const inputs = body.inputs as Record<string, string>;
    expect(Object.keys(inputs).sort()).toEqual(
      [
        'broker_dispatch_token',
        'broker_generation',
        'broker_intent_id',
        'context',
        'issue',
        'mode',
        'reply',
        'runbook',
      ].sort(),
    );
    expect(inputs.issue).toBe('7');
    expect(inputs.mode).toBe('implement');
    expect(inputs.reply).toBe('');
    expect(inputs.runbook).toBe('');
    expect(inputs.context).toBe('');
    expect(inputs.broker_intent_id).toBe(run.runId);
    expect(inputs.broker_generation).toBe('1');
    expect(inputs.broker_dispatch_token.length).toBeGreaterThanOrEqual(16);

    expect(result.dispatched).toEqual([run.runId]);
    expect(result.failed).toEqual([]);

    expect((await store.readRun(run.runId))?.state).toBe('running');

    // A second drain has nothing left to claim.
    const second = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });
    expect(second.dispatched).toEqual([]);
    expect(calls).toHaveLength(3); // no additional fetch call
  });

  it('dispatches against an injected GitHub API root', async () => {
    const { store, orchestrator } = fixture();
    await started(orchestrator);
    const { fetchImpl, calls } = fakeFetch(204);

    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      githubApiBaseUrl: 'https://fixture.invalid/github/',
    });

    expect(calls[0]?.url).toBe(
      'https://fixture.invalid/github/repos/octo/example/actions/workflows/claude.yml/dispatches',
    );
  });

  it('sends one workflow_dispatch request across two concurrent drains', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    let releaseFetch!: () => void;
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      markFetchStarted();
      await fetchReleased;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const deps = {
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    };

    const firstDrain = drainOutbox(deps);
    await fetchStarted;
    const overlappingDrain = await drainOutbox(deps);

    expect(calls).toHaveLength(1);
    expect(overlappingDrain).toEqual({
      dispatched: [],
      reported: [],
      failed: [],
    });

    releaseFetch();
    const firstResult = await firstDrain;
    expect(firstResult.dispatched).toEqual([run.runId]);
    // workflow_dispatch + the confirmed dispatch's eyes-reaction/assignee
    // projection, all unblocked once `releaseFetch()` resolves the shared
    // `fetchReleased` promise.
    expect(calls).toHaveLength(3);
  });

  it('does not pre-lease later entries while an earlier delivery is slow', async () => {
    const { clock, store, orchestrator } = fixture();
    const firstRun = await started(orchestrator, 'req-1');
    await orchestrator.report(firstRun.run.runId, { ok: true });
    const secondRun = await started(orchestrator, 'req-2');
    const claimSpy = vi.spyOn(store, 'claimPendingOutbox');
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      // The workflow_dispatch call and its confirmed-dispatch eyes-reaction/
      // assignee projection all resolve instantly, matching the dispatch
      // path above -- only the outcome-comment delivery below is slow.
      if (
        url.includes('/actions/workflows/') ||
        url.endsWith('/reactions') ||
        url.endsWith('/assignees')
      ) {
        return new Response(null, { status: 204 });
      }
      // Simulate a slow-but-successful earlier delivery. The next entry's
      // lease must begin at this later time, not share the drain's start time.
      clock.advanceMinutes(6);
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

    expect(result.reported).toEqual([firstRun.run.runId]);
    expect(result.dispatched).toEqual([secondRun.run.runId]);
    expect(claimSpy.mock.calls.map(([input]) => input.limit)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(claimSpy.mock.calls.map(([input]) => input.now)).toEqual([
      T0,
      T0,
      '2026-08-15T12:06:00.000Z',
      '2026-08-15T12:06:00.000Z',
    ]);
    expect(claimSpy.mock.calls[2]?.[0]).toMatchObject({
      leaseExpiresAt: '2026-08-15T12:11:00.000Z',
    });
  });

  it('forwards mode/reply from run params verbatim', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator, 'req-1', {
      mode: 'reply',
      reply: 'thanks for the update',
    });
    const { fetchImpl, calls } = fakeFetch(204);

    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    const inputs = callBody(calls[0]!).inputs as Record<string, string>;
    expect(inputs.mode).toBe('reply');
    expect(inputs.reply).toBe('thanks for the update');
    expect(inputs.broker_intent_id).toBe(run.runId);
  });

  // #1215: the request path's whole point is carrying these two through to
  // the worker -- a label admission has no way to set either.
  it('forwards runbook/context from run params verbatim', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator, 'req-1', {
      mode: 'implement',
      runbook: 'pr-heal',
      context: 'nightly sweep',
    });
    const { fetchImpl, calls } = fakeFetch(204);

    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    const inputs = callBody(calls[0]!).inputs as Record<string, string>;
    expect(inputs.runbook).toBe('pr-heal');
    expect(inputs.context).toBe('nightly sweep');
    expect(inputs.broker_intent_id).toBe(run.runId);
  });

  it('leaves the entry pending and records a failure on a non-204 response, retrying later', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);

    const failing = fakeFetch(500);
    const first = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
    });

    expect(first.dispatched).toEqual([]);
    expect(first.failed).toEqual([
      {
        entryId: `dispatch/${run.runId}`,
        error: expect.stringContaining('500'),
      },
    ]);
    expect((await store.readRun(run.runId))?.state).toBe('pending');

    const succeeding = fakeFetch(204);
    const second = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: succeeding.fetchImpl,
    });

    expect(second.dispatched).toEqual([run.runId]);
    expect(second.failed).toEqual([]);
    expect((await store.readRun(run.runId))?.state).toBe('running');
  });

  it('settles a stale dispatch entry (run already finished) without any fetch call', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);

    // The run finishes (still legal from `pending`, before ever being
    // dispatched) before the dispatch-run entry is ever drained.
    const reportOutcome = await orchestrator.report(run.runId, { ok: true });
    if (isRefusal(reportOutcome)) {
      throw new Error(`unexpected refusal: ${reportOutcome.reason}`);
    }
    // Isolate the dispatch-run entry: settle the report-outcome entry that
    // came with it out of band so this drain call only sees the stale one.
    const claims = await store.claimPendingOutbox({
      limit: 10,
      now: clock.now(),
      leaseExpiresAt: new Date(
        Date.parse(clock.now()) + OUTBOX_LEASE_MS,
      ).toISOString(),
    });
    for (const claim of claims) {
      await store.settleOutbox({
        entryId: claim.entryId,
        claimId: claim.claimId,
        state: claim.kind === 'report-outcome' ? 'done' : 'pending',
        now: clock.now(),
      });
    }

    const neverCalled = vi.fn<typeof fetch>();

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: neverCalled,
    });

    expect(neverCalled).not.toHaveBeenCalled();
    expect(result.dispatched).toEqual([]);
    expect(result.failed).toEqual([]);

    // Nothing left pending for a later drain either.
    const again = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: neverCalled,
    });
    expect(again.dispatched).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it('dispatches a native run with a work input and no issue', async () => {
    const { store, orchestrator } = fixture();
    const decision = await orchestrator.request({
      taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
      requestId: 'w1',
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'console' },
        spec: {
          title: 'x',
          description: 'd',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
    if (isRefusal(decision)) {
      throw new Error(`unexpected refusal: ${decision.reason}`);
    }
    const { fetchImpl, calls } = fakeFetch(204);

    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/octo/example/actions/workflows/claude.yml/dispatches',
    );
    const body = callBody(calls[0]!);
    const inputs = body.inputs as Record<string, unknown>;
    expect(inputs.issue).toBeUndefined();
    expect(JSON.parse(inputs.work as string)).toEqual({
      id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      spec: {
        title: 'x',
        description: 'd',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
    });
    expect(Object.keys(inputs).sort()).toEqual([
      'broker_dispatch_token',
      'broker_generation',
      'broker_intent_id',
      'mode',
      'work',
    ]);
    expect(inputs.broker_intent_id).toBe('work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1');
  });

  it('fails a native run permanently when the work spec is invalid (missing description)', async () => {
    const { store, orchestrator } = fixture();
    const decision = await orchestrator.request({
      taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E4H' },
      requestId: 'w2',
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'console' },
        // No `description` -- workSpecSchema.parse must throw on this.
        spec: {
          title: 'x',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
    if (isRefusal(decision)) {
      throw new Error(`unexpected refusal: ${decision.reason}`);
    }
    const neverCalled = vi.fn<typeof fetch>();

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: neverCalled,
    });

    expect(result.dispatched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error.length).toBeGreaterThan(0);
    expect(neverCalled).not.toHaveBeenCalled();

    // Settled `done`, not left pending for retry: a second drain sees
    // nothing left to do, and still never calls fetch.
    const again = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: neverCalled,
    });
    expect(again.dispatched).toEqual([]);
    expect(again.failed).toEqual([]);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it('a control-plane GitHub-anchored run with a work payload emits both issue and work inputs', async () => {
    // Only this repo's own worker/shim workflows declare a `work`
    // workflow_dispatch input today (#1544 tracks adding it to the six
    // consumer repos) -- so the gate in orchestrator-dispatch.ts only
    // allows `work` through when the anchor's own repo (not the spec's
    // `target.repo`, which is independent -- see anchor-target.ts) is the
    // control plane. `controlPlaneRepository()` falls back to
    // `jlapenna/agent-lcars` with no env var set (see deployment.test.ts).
    const { store, orchestrator } = fixture();
    const controlPlaneTask: TaskId = { repo: 'jlapenna/agent-lcars', issue: 7 };
    const requested = await orchestrator.request({
      taskId: controlPlaneTask,
      requestId: 'req-1',
      pipeline: 'claude',
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'T',
          description: 'D',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
    if (isRefusal(requested)) {
      throw new Error(`unexpected refusal: ${requested.reason}`);
    }
    const { fetchImpl, calls } = fakeFetch(204);

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    // workflow_dispatch + the confirmed dispatch's eyes-reaction/assignee
    // projection (see the dedicated tests below).
    expect(calls).toHaveLength(3);
    const inputs = callBody(calls[0]!).inputs as Record<string, string>;
    // A GitHub anchor is already named by `issue` -- `work` carries only
    // `spec`, no `id` (unlike the native-anchor `work` input above).
    expect(Object.keys(inputs).sort()).toEqual(
      [
        'broker_dispatch_token',
        'broker_generation',
        'broker_intent_id',
        'context',
        'issue',
        'mode',
        'reply',
        'runbook',
        'work',
      ].sort(),
    );
    expect(inputs.issue).toBe('7');
    expect(JSON.parse(inputs.work)).toEqual({
      spec: {
        title: 'T',
        description: 'D',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
    });
    expect(result.dispatched).toEqual([decidedRun(requested).runId]);
  });

  it('a NON-control-plane GitHub-anchored run with a work payload omits the work input (#1544)', async () => {
    // The webhook admits every repo in AGENT_LCARS_CONTROL_PLANE_REPOSITORIES,
    // but only this repo's own worker/shim workflows declare `work` as a
    // workflow_dispatch input today -- sending it to a consumer repo 422s
    // and, because `drainOutbox` treats a non-204 response as retryable and
    // stops draining on the first failure, that one poisoned entry would
    // block every later outbox entry forever. `TASK` (octo/example) is not
    // the control-plane repo, so `work` must be dropped, leaving exactly
    // the pre-existing input set.
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: TASK,
      requestId: 'req-1',
      pipeline: 'claude',
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'T',
          description: 'D',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
    if (isRefusal(requested)) {
      throw new Error(`unexpected refusal: ${requested.reason}`);
    }
    const { fetchImpl, calls } = fakeFetch(204);

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    expect(calls).toHaveLength(3);
    const inputs = callBody(calls[0]!).inputs as Record<string, string>;
    expect(Object.keys(inputs).sort()).toEqual(
      [
        'broker_dispatch_token',
        'broker_generation',
        'broker_intent_id',
        'context',
        'issue',
        'mode',
        'reply',
        'runbook',
      ].sort(),
    );
    expect(inputs.issue).toBe('7');
    expect(inputs.work).toBeUndefined();
    expect(result.dispatched).toEqual([decidedRun(requested).runId]);
  });

  it('posts an eyes reaction and claims the fleet assignee after confirming a GitHub-anchored dispatch', async () => {
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
      requestId: 'req-1',
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');

    const { fetchImpl, calls } = fakeFetch(204);
    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    const reactionCall = calls.find((c) =>
      c.url.endsWith('/issues/42/reactions'),
    );
    expect(reactionCall).toBeDefined();
    expect(JSON.parse(reactionCall!.init.body as string)).toEqual({
      content: 'eyes',
    });

    const assigneeCall = calls.find((c) =>
      c.url.endsWith('/issues/42/assignees'),
    );
    expect(assigneeCall).toBeDefined();
    expect(JSON.parse(assigneeCall!.init.body as string)).toEqual({
      assignees: ['agent-lcars-bot'],
    });
  });

  it('a native anchor posts no eyes reaction or claim', async () => {
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: { workId: '01PROJECTIONTESTFIXTUREX01' },
      requestId: 'req-1',
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'api' },
        spec: {
          title: 't',
          description: 'd',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');

    const { fetchImpl, calls } = fakeFetch(204);
    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    expect(calls.some((c) => c.url.includes('/reactions'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/assignees'))).toBe(false);
  });

  it('a failed claim/reaction call does not fail the dispatch', async () => {
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
      requestId: 'req-1',
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');

    // First call (workflow_dispatch) succeeds; reaction/assignee calls fail.
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response(null, { status: call === 1 ? 204 : 500 });
    }) as typeof fetch;
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    expect(result.dispatched).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('logs the status and body when a claim-projection POST returns a non-2xx response (item 4)', async () => {
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
      requestId: 'req-1',
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');

    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      // workflow_dispatch succeeds (204); both claim-projection POSTs come
      // back as a real HTTP failure (not a network-level rejection -- see
      // the dedicated network-failure test above/below) so `response.ok`
      // is false and the new logging path (not the `catch` block) fires.
      let call = 0;
      const fetchImpl = (async () => {
        call += 1;
        if (call === 1) return new Response(null, { status: 204 });
        return new Response('server exploded', { status: 500 });
      }) as typeof fetch;

      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl,
      });

      // Best-effort: a projection failure must never fail the dispatch
      // itself, exactly as the pre-existing 500 test above already
      // covers -- this test's own job is proving the *logging*.
      expect(result.dispatched).toHaveLength(1);
      expect(result.failed).toHaveLength(0);

      expect(errorSpy).toHaveBeenCalledWith(
        'agent-lcars: claim projection (reaction) failed for %s#%s: %s %s',
        'jlapenna/agent-lcars',
        42,
        500,
        'server exploded',
      );
      expect(errorSpy).toHaveBeenCalledWith(
        'agent-lcars: claim projection (assignee) failed for %s#%s: %s %s',
        'jlapenna/agent-lcars',
        42,
        500,
        'server exploded',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('projects the assignee independently of a reactions-call network failure', async () => {
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
      requestId: 'req-1',
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');

    // workflow_dispatch succeeds; the reactions call rejects at the network
    // level (not merely a bad status) -- the assignees call must still fire.
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/reactions')) {
        throw new TypeError('network error');
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    expect(calls.some((c) => c.url.endsWith('/issues/42/reactions'))).toBe(
      true,
    );
    const assigneeCall = calls.find((c) =>
      c.url.endsWith('/issues/42/assignees'),
    );
    expect(assigneeCall).toBeDefined();
    expect(JSON.parse(assigneeCall!.init.body as string)).toEqual({
      assignees: ['agent-lcars-bot'],
    });
    // The dispatch itself, and the outbox entry, are unaffected.
    expect(result.dispatched).toHaveLength(1);
    expect(result.failed).toEqual([]);
  });

  it('re-projects the claim (once) for a reclaimed dispatch-run entry whose run is already running, then settles done', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);

    // Simulate a crash between `confirmDispatch` succeeding and this
    // entry's own settlement: claim the entry (as a first drain would),
    // advance the run to `running` exactly like the primary dispatch path
    // does, but never settle the entry itself.
    const [claimed] = await store.claimPendingOutbox({
      limit: 1,
      now: clock.now(),
      leaseExpiresAt: new Date(
        Date.parse(clock.now()) + OUTBOX_LEASE_MS,
      ).toISOString(),
    });
    expect(claimed?.entryId).toBe(`dispatch/${run.runId}`);
    await orchestrator.confirmDispatch(run.runId);
    expect((await store.readRun(run.runId))?.state).toBe('running');

    // Advance past the original lease so a later drain can reclaim the
    // still-`leased`-but-expired entry, as a real recovering drain would.
    clock.advanceMinutes(OUTBOX_LEASE_MS / 60_000 + 1);

    const { fetchImpl, calls } = fakeFetch(204);
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

    // No workflow_dispatch fired again -- only the idempotent projection.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith(`/issues/7/reactions`))).toBe(true);
    expect(calls.some((c) => c.url.endsWith(`/issues/7/assignees`))).toBe(true);
    expect(result.dispatched).toEqual([]);
    expect(result.failed).toEqual([]);

    // The entry itself settled `done`: nothing left for a later drain.
    const again = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    expect(again).toEqual({ dispatched: [], reported: [], failed: [] });
  });

  it('a queue-executor run is enqueued and confirmed without calling GitHub', async () => {
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: { workId: '01QUEUEDRAINTESTFIXTUREX01' },
      requestId: 'req-1',
      pipeline: 'claude',
      executor: 'queue',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'api' },
        spec: {
          title: 't',
          description: 'd',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');
    const runId = decidedRun(requested).runId;

    const { fetchImpl, calls } = fakeFetch(204);
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    expect(calls).toHaveLength(0);
    expect(result.dispatched).toEqual([runId]);
    const run = await store.readRun(runId);
    expect(run?.state).toBe('running');
    expect(run?.queue).toEqual({ state: 'queued' });
  });
});

describe('drainOutbox: report-outcome', () => {
  it('posts the finished outcome, including the ref, and settles', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(204).fetchImpl,
    });

    const ref = 'https://github.com/octo/example/pull/42';
    const reportOutcome = await orchestrator.report(run.runId, {
      ok: true,
      ref,
    });
    if (isRefusal(reportOutcome)) {
      throw new Error(`unexpected refusal: ${reportOutcome.reason}`);
    }

    const { fetchImpl, calls } = fakeFetch(201);
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      githubApiBaseUrl: 'https://fixture.invalid/github',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://fixture.invalid/github/repos/octo/example/issues/7/comments',
    );
    const body = callBody(calls[0]!).body as string;
    expect(body).toContain(`Run ${run.runId} finished.`);
    expect(body).toContain(ref);

    expect(result.reported).toEqual([run.runId]);
    expect(result.failed).toEqual([]);

    const second = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });
    expect(second.reported).toEqual([]);
    expect(calls).toHaveLength(1); // no additional fetch call
  });

  it('settles report-outcome for a native run without calling GitHub', async () => {
    const { store, orchestrator } = fixture();
    const decision = await orchestrator.request({
      taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3H' },
      requestId: 'w1',
      pipeline: 'claude',
      work: { spec: { target: { repo: 'octo/example' } } },
    });
    if (isRefusal(decision)) {
      throw new Error(`unexpected refusal: ${decision.reason}`);
    }
    const { fetchImpl, calls } = fakeFetch(204);
    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    const reportOutcome = await orchestrator.report(
      'work:01J5Z3K9QX8F0N2B4V6C8D1E3H/r1',
      { ok: false },
    );
    if (isRefusal(reportOutcome)) {
      throw new Error(`unexpected refusal: ${reportOutcome.reason}`);
    }

    const before = calls.length;
    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    // Not just "no /issues/ call" -- a native anchor's report-outcome must
    // make no GitHub call at all, since it has no issue to comment on.
    expect(calls.slice(before)).toEqual([]);
  });

  it('posts the lost-run comment naming the auto-retried run, and dispatches that retry', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(204).fetchImpl,
    });

    clock.advanceMinutes(121);
    const settled = await orchestrator.sweepExpired();
    expect(settled.lost.map((r) => r.state)).toEqual(['lost']);
    expect(settled.retried).toHaveLength(1);
    const newRunId = settled.retried[0]!.newRunId;

    const { fetchImpl, calls } = routedFetch();
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      githubApiBaseUrl: 'https://fixture.invalid/github',
    });

    // the retry's dispatch + its eyes-reaction/assignee projection, and the
    // lost comment.
    expect(calls).toHaveLength(4);
    const commentCall = calls.find((c) => c.url.endsWith('/comments'));
    expect(commentCall?.url).toBe(
      'https://fixture.invalid/github/repos/octo/example/issues/7/comments',
    );
    const body = callBody(commentCall!).body as string;
    expect(body).toBe(
      `⚠️ Run ${run.runId} was lost (no report before its lease expired). ` +
        `Retrying automatically as run ${newRunId} ` +
        `(attempt 2 of ${MAX_AUTO_RETRIES + 1}).`,
    );

    expect(result.reported).toEqual([run.runId]);
    expect(result.dispatched).toEqual([newRunId]);
  });

  it('says the executor failed, not that a lease expired, for a terminal-settled run (#1361)', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await orchestrator.confirmDispatch(run.runId);
    // One minute in: the lease is nowhere near expiry, so claiming it
    // expired would be plainly false.
    clock.advanceMinutes(1);
    const settled = await orchestrator.settleTerminalRuns([
      { runId: run.runId, conclusion: 'startup_failure' },
    ]);
    const newRunId = settled.retried[0]!.newRunId;

    const { fetchImpl, calls } = routedFetch();
    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    const commentCall = calls.find((c) => c.url.endsWith('/comments'));
    expect(callBody(commentCall!).body).toBe(
      `⚠️ Run ${run.runId} was lost (executor terminal: startup_failure, ` +
        `no completion report). Retrying automatically as run ${newRunId} ` +
        `(attempt 2 of ${MAX_AUTO_RETRIES + 1}).`,
    );
  });

  it('exhausts the auto-retry budget after 3 consecutive losses: exhausted comment + best-effort needs-human label', async () => {
    const { clock, store, orchestrator } = fixture();
    await started(orchestrator);
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: routedFetch().fetchImpl,
    });

    // Two losses that each auto-retry (dispatched so the next iteration has
    // a fresh live run to expire); the third loss exceeds MAX_AUTO_RETRIES
    // (2) and is left parked.
    for (let i = 0; i < 2; i++) {
      clock.advanceMinutes(121);
      const swept = await orchestrator.sweepExpired();
      expect(swept.retried).toHaveLength(1);
      await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl: routedFetch().fetchImpl,
      });
    }
    clock.advanceMinutes(121);
    const finalSweep = await orchestrator.sweepExpired();
    expect(finalSweep.retried).toEqual([]); // budget exhausted, no fourth run
    const exhaustedRunId = finalSweep.lost[0]!.runId;

    const { fetchImpl, calls } = routedFetch();
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      githubApiBaseUrl: 'https://fixture.invalid/github',
    });

    const commentCall = calls.find((c) => c.url.endsWith('/comments'));
    expect(commentCall?.url).toBe(
      'https://fixture.invalid/github/repos/octo/example/issues/7/comments',
    );
    const commentBody = callBody(commentCall!).body as string;
    expect(commentBody).toBe(
      `⚠️ Run ${exhaustedRunId} was lost (no report before its lease expired). ` +
        `Auto-retry budget exhausted -- re-request manually (re-add the ` +
        `agent label) when ready.`,
    );

    const labelCall = calls.find((c) => c.url.endsWith('/labels'));
    expect(labelCall?.url).toBe(
      'https://fixture.invalid/github/repos/octo/example/issues/7/labels',
    );
    expect(labelCall?.init.method).toBe('POST');
    expect(JSON.parse(String(labelCall?.init.body))).toEqual({
      labels: ['status:needs-human'],
    });

    expect(result.reported).toEqual([exhaustedRunId]);
  });

  it('falls back to naming the live run when no auto-retry exists for this loss (e.g. a manual re-request raced it)', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator, 'req-1');
    const task = await store.readTask(TASK);
    if (task === undefined) throw new Error('expected task to exist');

    clock.advanceMinutes(121);
    const now = clock.now();
    // Apply the raw expire decision directly, bypassing
    // `orchestrator.sweepExpired()` (which would auto-retry this exact
    // run). This simulates the end state a race would leave behind: the
    // run is lost, but no `retry:<lostRunId>`-requestId successor exists,
    // because an operator's manual re-request landed first instead.
    const decision = expireLease({ now, task: task.task, run });
    if (isRefusal(decision)) throw new Error('unexpected refusal');
    await store.apply({ decision, expectedRevision: task.revision });

    const manual = await orchestrator.request({
      taskId: TASK,
      requestId: 'manual-race',
      pipeline: 'claude',
    });
    if (isRefusal(manual)) throw new Error('unexpected refusal');

    const { fetchImpl, calls } = routedFetch();
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    const commentCall = calls.find((c) => c.url.endsWith('/comments'));
    const body = callBody(commentCall!).body as string;
    expect(body).toBe(
      `⚠️ Run ${run.runId} was lost (no report before its lease expired). ` +
        `Run ${manual.run.runId} is already in progress.`,
    );
    expect(calls.some((c) => c.url.endsWith('/labels'))).toBe(false);
    expect(result.reported).toEqual([run.runId]);
  });

  it('a finished-not-ok outcome also gets the status:needs-human label', async () => {
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
      requestId: 'req-1',
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');
    const runId = decidedRun(requested).runId;
    await orchestrator.confirmDispatch(runId);
    await orchestrator.report(runId, { ok: false, summary: 'blocked' });

    // routedFetch, not fakeFetch (which only ever takes one status): this
    // one drainOutbox call settles two outbox entries -- the original
    // dispatch-run entry, now stale since confirmDispatch was called
    // directly above rather than through a drain (handleDispatchRun's own
    // `run.state !== 'pending'` guard settles it `done` without ever
    // calling fetch), and the report-outcome entry `report()` created,
    // which needs both a comment (201) and a label (200) call to succeed.
    const { fetchImpl, calls } = routedFetch();
    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    const labelCall = calls.find((c) => c.url.endsWith('/issues/42/labels'));
    expect(labelCall).toBeDefined();
    expect(JSON.parse(labelCall!.init.body as string)).toEqual({
      labels: ['status:needs-human'],
    });

    const commentCall = calls.find((c) =>
      c.url.endsWith('/issues/42/comments'),
    );
    const commentBody = callBody(commentCall!).body as string;
    expect(commentBody).toBe(
      `❌ Run ${runId} failed.\n` +
        `blocked\n` +
        `No auto-retry will follow -- re-request manually (re-add the ` +
        `agent label) when ready.`,
    );
  });

  it('a needs-human label failure does not fail the drain, and does not block settling the entry (best-effort)', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(204).fetchImpl,
    });

    const reportOutcome = await orchestrator.report(run.runId, {
      ok: false,
      summary: 'blocked',
    });
    if (isRefusal(reportOutcome)) {
      throw new Error(`unexpected refusal: ${reportOutcome.reason}`);
    }

    const { fetchImpl, calls } = routedFetch({ labelStatus: 500 });
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
    });

    expect(calls.some((c) => c.url.endsWith('/labels'))).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.reported).toEqual([run.runId]);

    // Settled `done` despite the label failure: a later drain does not
    // re-post the (already-delivered) comment.
    const again = await drainOutbox({ store, orchestrator, tokens, fetchImpl });
    expect(again.reported).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith('/comments'))).toHaveLength(1);
  });
});
