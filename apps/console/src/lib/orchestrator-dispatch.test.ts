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
import {
  drainOutbox,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_CAP_MS,
  OUTBOX_RETIRE_AFTER_MS,
  OUTBOX_STALE_REPORT_AGE_MS,
} from './orchestrator-dispatch';

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

/** A fake fetch for the `work`-input-onboarding-gap retry (#1554 review,
 *  `PRRT_kwDOTemFxc6c7KaP`): its first call returns GitHub's real 422 shape
 *  for an undeclared `workflow_dispatch` input (see
 *  `unexpectedDispatchInputs`'s doc comment in orchestrator-dispatch.ts for
 *  where that wording is confirmed), and every call after that succeeds. */
function fetch422ThenSucceed(unexpectedInputs: string[]): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let call = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    call += 1;
    if (call === 1) {
      return new Response(
        JSON.stringify({
          message: `Unexpected inputs provided: ${JSON.stringify(unexpectedInputs)}`,
        }),
        { status: 422 },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function workTaskParams() {
  return {
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'T',
        description: 'D',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
    },
  };
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
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);

    const failing = fakeFetch(500);
    const first = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
      now: () => clock.now(),
    });

    expect(first.dispatched).toEqual([]);
    expect(first.failed).toEqual([
      {
        entryId: `dispatch/${run.runId}`,
        error: expect.stringContaining('500'),
      },
    ]);
    expect((await store.readRun(run.runId))?.state).toBe('pending');

    // #1548 follow-up: the failure above started this entry's backoff
    // window (see `OUTBOX_BACKOFF_BASE_MS`) -- advance past it, otherwise
    // this immediate retry is exactly the "fast dispatch/completion drain
    // cadence hammering a currently-failing entry" the backoff exists to
    // prevent (covered on its own below).
    clock.advanceMinutes(2);
    const succeeding = fakeFetch(204);
    const second = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: succeeding.fetchImpl,
      now: () => clock.now(),
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

  it('includes resume in the work input when the run carries a resumeSessionId', async () => {
    const { store, orchestrator } = fixture();
    const decision = await orchestrator.request({
      taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E5X' },
      requestId: 'w-resume-1',
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
      params: {
        resumeSessionId: 'sess_1',
        resumeTranscriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      },
    });
    if (isRefusal(decision)) {
      throw new Error(`unexpected refusal: ${decision.reason}`);
    }
    const { fetchImpl, calls } = fakeFetch(204);

    await drainOutbox({ store, orchestrator, tokens, fetchImpl });

    expect(calls).toHaveLength(1);
    const body = callBody(calls[0]!);
    const inputs = body.inputs as Record<string, unknown>;
    const work = JSON.parse(inputs.work as string) as Record<string, unknown>;
    expect(work.resume).toEqual({
      sessionId: 'sess_1',
      transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
    });
  });

  it('omits resume from the work input when the run carries no resumeSessionId', async () => {
    const { store, orchestrator } = fixture();
    const decision = await orchestrator.request({
      taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E6Y' },
      requestId: 'w-resume-2',
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
    const body = callBody(calls[0]!);
    const inputs = body.inputs as Record<string, unknown>;
    const work = JSON.parse(inputs.work as string) as Record<string, unknown>;
    expect(work.resume).toBeUndefined();
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
    // `controlPlaneRepository()` falls back to `jlapenna/agent-lcars` with
    // no env var set (see deployment.test.ts). `work` is emitted here
    // simply because `task.work` is defined -- see the NON-control-plane
    // case below for the (now-removed, #1544 wave 2) repo gate this used
    // to also require.
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

  it('a NON-control-plane, admitted GitHub-anchored run with a work payload still emits the work input (#1544 wave 2)', async () => {
    // Wave 1 of #1544 landed a `work` `workflow_dispatch` input on every
    // consumer repo's `claude/codex/opencode.yml` declared in
    // `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (six repos, all merged), so
    // `handleDispatchRun` no longer gates `work` down to just
    // `controlPlaneRepository()`. `TASK` (octo/example) is admitted here
    // via the allow-list env var -- the same admission the webhook already
    // required before this GitHub-anchored task could exist at all (see
    // `orchestrator-ingest.ts`'s `checkRepository`) -- and is not the
    // control-plane repo, proving the repo half of the old gate is gone.
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
      'jlapenna/agent-lcars,octo/example';
    try {
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
    } finally {
      delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
    }
  });

  // #1554 review (PRRT_kwDOTemFxc6c7KaP): the onboarding sequence in
  // docs/onboarding-repo.md admits a repository to
  // AGENT_LCARS_CONTROL_PLANE_REPOSITORIES (step 1) before that repo's own
  // workflow callers declare the `work` input (step 4). A webhook landing
  // in that gap mints a GitHub-anchored task with `work`, and GitHub 422s
  // the dispatch. These four tests cover the degrade-and-retry fix.
  describe('workflow_dispatch 422 for an undeclared `work` input', () => {
    it('retries exactly once without `work` and dispatches on the legacy issue-anchored path', async () => {
      const { store, orchestrator } = fixture();
      const requested = await orchestrator.request({
        taskId: TASK,
        requestId: 'req-1',
        pipeline: 'claude',
        ...workTaskParams(),
      });
      if (isRefusal(requested)) throw new Error('unexpected refusal');

      const { fetchImpl, calls } = fetch422ThenSucceed(['work']);

      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl,
      });

      const dispatchCalls = calls.filter((c) =>
        c.url.includes('/actions/workflows/'),
      );
      // Exactly one retry: the first (422'd) call plus one retry, no loop.
      expect(dispatchCalls).toHaveLength(2);

      const firstInputs = callBody(dispatchCalls[0]!).inputs as Record<
        string,
        string
      >;
      expect(firstInputs.work).toBeDefined();
      expect(firstInputs.issue).toBe('7');

      const retryInputs = callBody(dispatchCalls[1]!).inputs as Record<
        string,
        string
      >;
      expect(retryInputs.work).toBeUndefined();
      expect(Object.keys(retryInputs).sort()).toEqual(
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
      expect(retryInputs.issue).toBe('7');

      expect(result.dispatched).toEqual([decidedRun(requested).runId]);
      expect(result.failed).toEqual([]);
      expect((await store.readRun(decidedRun(requested).runId))?.state).toBe(
        'running',
      );
    });

    it('logs that the retry happened, at a visible level (console.error)', async () => {
      const { store, orchestrator } = fixture();
      const requested = await orchestrator.request({
        taskId: TASK,
        requestId: 'req-1',
        pipeline: 'claude',
        ...workTaskParams(),
      });
      if (isRefusal(requested)) throw new Error('unexpected refusal');

      const { fetchImpl } = fetch422ThenSucceed(['work']);
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        await drainOutbox({ store, orchestrator, tokens, fetchImpl });

        expect(errorSpy).toHaveBeenCalledWith(
          'agent-lcars: dispatch to %s#%s named unexpected input(s) [%s] ' +
            '(422) -- retrying once without `work` on the legacy ' +
            'issue-anchored path',
          'octo/example',
          7,
          'work',
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('does NOT retry a 422 for an unrelated reason, and fails the entry as before', async () => {
      const { store, orchestrator } = fixture();
      const requested = await orchestrator.request({
        taskId: TASK,
        requestId: 'req-1',
        pipeline: 'claude',
        ...workTaskParams(),
      });
      if (isRefusal(requested)) throw new Error('unexpected refusal');

      const calls: FetchCall[] = [];
      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        calls.push({ url: String(input), init: init ?? {} });
        // A real GitHub 422 shape unrelated to unexpected inputs (e.g. an
        // optional boolean input with no default) -- must not be mistaken
        // for the unexpected-`work`-input case.
        return new Response(
          JSON.stringify({
            message:
              "Provided value '' for input 'debug' not in the list of allowed values",
          }),
          { status: 422 },
        );
      }) as typeof fetch;

      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl,
      });

      const dispatchCalls = calls.filter((c) =>
        c.url.includes('/actions/workflows/'),
      );
      expect(dispatchCalls).toHaveLength(1);
      expect(result.dispatched).toEqual([]);
      expect(result.failed).toEqual([
        {
          entryId: `dispatch/${decidedRun(requested).runId}`,
          error: 'workflow_dispatch returned 422',
        },
      ]);
      expect((await store.readRun(decidedRun(requested).runId))?.state).toBe(
        'pending',
      );
    });

    it('makes exactly one dispatch call when the first attempt succeeds', async () => {
      const { store, orchestrator } = fixture();
      const requested = await orchestrator.request({
        taskId: TASK,
        requestId: 'req-1',
        pipeline: 'claude',
        ...workTaskParams(),
      });
      if (isRefusal(requested)) throw new Error('unexpected refusal');

      const { fetchImpl, calls } = fakeFetch(204);

      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl,
      });

      const dispatchCalls = calls.filter((c) =>
        c.url.includes('/actions/workflows/'),
      );
      expect(dispatchCalls).toHaveLength(1);
      expect(result.dispatched).toEqual([decidedRun(requested).runId]);
    });
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

  // #1548 canary (jlapenna/sync-padd#89, 2026-08-27): GitHub's
  // `POST .../issues/{n}/assignees` returns 2xx even when the requested
  // login lacks push access to the repository -- it silently omits the
  // login from the returned issue's `assignees` array instead of erroring.
  // A bare `response.ok` check cannot see this; only the response body can.
  it('logs an actionable warning when a 2xx assignee response silently drops the fleet login (not assignable -- no push access)', async () => {
    const { store, orchestrator } = fixture();
    const requested = await orchestrator.request({
      taskId: { repo: 'jlapenna/sync-padd', issue: 89 },
      requestId: 'req-1',
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');

    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = String(input);
        if (url.includes('/actions/workflows/')) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith('/reactions')) {
          return new Response(JSON.stringify({ content: 'eyes' }), {
            status: 201,
          });
        }
        if (url.endsWith('/assignees')) {
          // GitHub's real shape: the (unchanged) issue, whose `assignees`
          // does not include a login that isn't assignable there.
          return new Response(JSON.stringify({ assignees: [] }), {
            status: 201,
          });
        }
        throw new Error(`unexpected fetch: ${url} ${JSON.stringify(init)}`);
      }) as typeof fetch;

      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl,
      });

      // Best-effort projection: a silently-dropped claim must not fail the
      // dispatch, which already succeeded.
      expect(result.dispatched).toHaveLength(1);
      expect(result.failed).toHaveLength(0);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('claim projection (assignee)'),
        'jlapenna/sync-padd',
        89,
        'agent-lcars-bot',
      );
      const [message] = errorSpy.mock.calls.find(
        (call) => call[1] === 'jlapenna/sync-padd' && call[2] === 89,
      )!;
      expect(message as string).toMatch(/not assignable|push access/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs nothing extra when a 2xx assignee response body confirms the fleet login was attached', async () => {
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
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/actions/workflows/')) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith('/reactions')) {
          return new Response(JSON.stringify({ content: 'eyes' }), {
            status: 201,
          });
        }
        if (url.endsWith('/assignees')) {
          return new Response(
            JSON.stringify({ assignees: [{ login: 'agent-lcars-bot' }] }),
            { status: 201 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl,
      });

      expect(result.dispatched).toHaveLength(1);
      expect(result.failed).toHaveLength(0);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
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
    const { clock, store, orchestrator } = fixture();
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
      now: () => clock.now(),
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
      now: () => clock.now(),
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
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

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
        now: () => clock.now(),
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
      now: () => clock.now(),
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
      now: () => clock.now(),
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
    const { clock, store, orchestrator } = fixture();
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
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

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
    const { clock, store, orchestrator } = fixture();
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
      now: () => clock.now(),
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

// #1548: the outbox drain was found stuck fleet-wide -- 162 pending
// `report-outcome` entries, some up to six days old, with `reported: []`
// from a manual reconcile. Root cause: `claimPendingOutbox`'s pending query
// has no ordering, and the old `drainOutbox` stopped its *entire* loop on
// the first failure -- so whichever entry an unordered query happened to
// hand back first, every invocation anywhere in the fleet claimed it,
// failed it, and gave up before ever reaching any other entry.
describe('drainOutbox: fairness and retirement across entries (#1548)', () => {
  /** Requests a GitHub-anchored run for `issue` and drains just its own
   *  dispatch-run entry, confirming the run so `report()` accepts it.
   *  Deliberately does NOT also report the outcome -- see the two-phase
   *  comment at this function's call site below for why. `now` must be
   *  the test's own fixture clock: a mismatched real-wall-clock `now`
   *  here could make this drain observe an *other*, unrelated pending
   *  entry as stale/backing-off against the real clock (since #1548's
   *  follow-up), spuriously touching state a fixture-clock-timed
   *  assertion elsewhere in the test depends on. */
  async function dispatchedRun(
    orchestrator: Orchestrator,
    store: MemoryStore,
    issue: number,
    now: () => string,
  ): Promise<string> {
    const requested = await orchestrator.request({
      taskId: { repo: 'octo/example', issue },
      requestId: `req-${issue}`,
      pipeline: 'claude',
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');
    const run = decidedRun(requested);
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(204).fetchImpl,
      now,
    });
    return run.runId;
  }

  it('does not let one persistently-failing report-outcome entry block a later, healthy one', async () => {
    const { clock, store, orchestrator } = fixture();

    // Two independent tasks, each dispatched (and only dispatched) first,
    // so no *report-outcome* entry exists yet while either dispatch-run
    // entry is being drained -- with one already pending, `drainOutbox`'s
    // default limit would otherwise happily claim it too, alongside the
    // one this call actually intends to touch.
    const badRunId = await dispatchedRun(orchestrator, store, 101, () =>
      clock.now(),
    );
    const goodRunId = await dispatchedRun(orchestrator, store, 102, () =>
      clock.now(),
    );

    // *Now* report both outcomes -- #101's report-outcome entry is created
    // first, so an unordered claim query hands it back before #102's --
    // exactly the shape that starved 145 of 162 real pending entries:
    // every one of them was created *after* the handful that kept winning
    // the race to the front of the queue.
    const badReport = await orchestrator.report(badRunId, { ok: true });
    if (isRefusal(badReport)) throw new Error('unexpected refusal');
    const goodReport = await orchestrator.report(goodRunId, { ok: true });
    if (isRefusal(goodReport)) throw new Error('unexpected refusal');

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/issues/101/')) {
        return new Response('server exploded', { status: 500 });
      }
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

    // The healthy entry is still delivered in this same drain call, despite
    // the other one failing -- it is not starved behind it.
    expect(result.reported).toEqual([goodRunId]);
    expect(result.failed).toEqual([
      {
        entryId: `outcome/${badRunId}`,
        error: expect.stringContaining('500'),
      },
    ]);

    // The failing entry is released for a later drain, not stuck forever
    // and not silently dropped -- but its first failure also started its
    // backoff window (see the dedicated backoff tests below), so the next
    // drain has to land after that window for the retry to actually be
    // attempted.
    clock.advanceMinutes(2);
    const retry = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(201).fetchImpl,
      now: () => clock.now(),
    });
    expect(retry.reported).toEqual([badRunId]);
  });
});

// #1548 follow-up (review thread PRRT_kwDOTemFxc6c54X_, P1): the original
// version of this fix retired an entry after `MAX_OUTBOX_DELIVERY_ATTEMPTS`
// (20) claims, with no backoff between them. Drains fire on every dispatch
// and completion, on top of the 30-minute reconcile heartbeat -- so normal
// fleet traffic could burn through 20 claims within minutes, and a lease
// recovered after a crash counted as a "claim" too, without a single
// delivery ever having been attempted. A transient GitHub outage or a bout
// of rate-limiting would therefore permanently lose a dispatch or outcome
// report -- worse than the unbounded-retry bug #1548 itself fixed.
// Retirement is now gated on elapsed time since the *first actual delivery
// failure* (`OUTBOX_RETIRE_AFTER_MS`), with exponential backoff between
// attempts (`OUTBOX_BACKOFF_BASE_MS`/`_CAP_MS`) so the entry isn't
// re-attempted on every single drain while it's failing.
describe('drainOutbox: elapsed-time retirement and backoff (#1548 follow-up)', () => {
  // Unlike the `reportedRun` above (which never touches backoff/retirement
  // timing), every call here MUST share the one fixture clock for its
  // internal drain -- otherwise that drain's default real-wall-clock `now`
  // could claim and re-judge some *other* entry's retirement/backoff state
  // (already set against the fixture clock's simulated time) against the
  // real clock instead, which is wildly, spuriously far in the future
  // relative to it.
  async function reportedRun(
    orchestrator: Orchestrator,
    store: MemoryStore,
    issue: number,
    now: () => string,
  ): Promise<string> {
    const requested = await orchestrator.request({
      taskId: { repo: 'octo/example', issue },
      requestId: `req-${issue}`,
      pipeline: 'claude',
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');
    const run = decidedRun(requested);
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(204).fetchImpl,
      now,
    });
    const reported = await orchestrator.report(run.runId, { ok: true });
    if (isRefusal(reported)) throw new Error('unexpected refusal');
    return run.runId;
  }

  it('does not retire an entry that keeps failing within the retirement window, even after far more than 20 (the old attempt cap) claims', async () => {
    const { clock, store, orchestrator } = fixture();
    const runId = await reportedRun(orchestrator, store, 401, () =>
      clock.now(),
    );
    const entryId = `outcome/${runId}`;
    const failing = fakeFetch(500);

    // 25 real delivery failures, each one advancing the clock by the full
    // backoff cap (so every drain lands past backoff, regardless of which
    // step it's on) -- 25 * 30 minutes is 12.5 hours, comfortably inside
    // `OUTBOX_RETIRE_AFTER_MS` (72 hours), but already well past the old
    // `MAX_OUTBOX_DELIVERY_ATTEMPTS` (20) claim-count cap this replaces.
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      const result = await drainOutbox({
        store,
        orchestrator,
        tokens,
        fetchImpl: failing.fetchImpl,
        now: () => clock.now(),
      });
      expect(result.failed).toEqual([
        { entryId, error: expect.stringContaining('500') },
      ]);
      clock.advanceMinutes(OUTBOX_BACKOFF_CAP_MS / 60_000);
    }

    // Still not retired: the entry is still `pending` and still gets a
    // real delivery attempt, not silently skipped.
    const callsBefore = failing.calls.length;
    const stillTrying = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
      now: () => clock.now(),
    });
    expect(stillTrying.failed).toEqual([
      { entryId, error: expect.stringContaining('500') },
    ]);
    expect(failing.calls.length).toBe(callsBefore + 1);
  });

  it('retires an entry once it has been failing longer than the retirement window', async () => {
    const { clock, store, orchestrator } = fixture();
    const runId = await reportedRun(orchestrator, store, 402, () =>
      clock.now(),
    );
    const entryId = `outcome/${runId}`;
    const failing = fakeFetch(500);

    const first = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
      now: () => clock.now(),
    });
    expect(first.failed).toEqual([
      { entryId, error: expect.stringContaining('500') },
    ]);

    // Well past the retirement window since that first failure -- this
    // drain's delivery attempt is the one that tips it over.
    clock.advanceMinutes(OUTBOX_RETIRE_AFTER_MS / 60_000 + 60);
    const tipsItOver = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
      now: () => clock.now(),
    });
    expect(tipsItOver.failed).toEqual([
      { entryId, error: expect.stringContaining('500') },
    ]);

    // Retired: a later drain finds nothing left to claim for it, and
    // (unlike every attempt above) never calls GitHub again.
    const callsBefore = failing.calls.length;
    const afterRetirement = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
      now: () => clock.now(),
    });
    expect(afterRetirement).toEqual({
      dispatched: [],
      reported: [],
      failed: [],
    });
    expect(failing.calls.length).toBe(callsBefore);
  });

  it('backoff suppresses re-attempts until it expires', async () => {
    const { clock, store, orchestrator } = fixture();
    const runId = await reportedRun(orchestrator, store, 403, () =>
      clock.now(),
    );
    const entryId = `outcome/${runId}`;
    const failing = fakeFetch(500);

    const first = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
      now: () => clock.now(),
    });
    expect(first.failed).toEqual([
      { entryId, error: expect.stringContaining('500') },
    ]);
    const callsAfterFirstFailure = failing.calls.length;

    // Immediately re-draining (same instant, no clock advance) is exactly
    // what a dispatch/completion-triggered drain landing right after a
    // failure looks like -- the entry is still backing off, so no delivery
    // call is made at all, and the drain simply finds nothing to claim.
    const whileBackingOff = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
      now: () => clock.now(),
    });
    expect(whileBackingOff).toEqual({
      dispatched: [],
      reported: [],
      failed: [],
    });
    expect(failing.calls.length).toBe(callsAfterFirstFailure);

    // Once backoff has elapsed, the entry is claimable and delivered again
    // -- this time successfully.
    clock.advanceMinutes(OUTBOX_BACKOFF_BASE_MS / 60_000 + 1);
    const succeeding = fakeFetch(201);
    const afterBackoff = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: succeeding.fetchImpl,
      now: () => clock.now(),
    });
    expect(afterBackoff.reported).toEqual([runId]);
    expect(succeeding.calls.length).toBe(1);
  });

  it('a backing-off entry does not prevent a different, healthy entry from being delivered in the same drain', async () => {
    const { clock, store, orchestrator } = fixture();
    const badRunId = await reportedRun(orchestrator, store, 404, () =>
      clock.now(),
    );

    // Put #404 into backoff via a standalone failing drain first (this
    // models a *prior* drain call's failure, distinct from the
    // `failedThisDrain` same-invocation exclusion covered above).
    const failFirst = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(500).fetchImpl,
      now: () => clock.now(),
    });
    expect(failFirst.failed).toEqual([
      {
        entryId: `outcome/${badRunId}`,
        error: expect.stringContaining('500'),
      },
    ]);

    // A second, healthy task's report-outcome entry, created and pending
    // only now -- #404 is still backing off (no clock advance) throughout.
    const goodRunId = await reportedRun(orchestrator, store, 405, () =>
      clock.now(),
    );

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/issues/404/')) {
        throw new Error('must not be re-attempted while backing off');
      }
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });
    expect(result.reported).toEqual([goodRunId]);
    expect(result.failed).toEqual([]);
  });

  it('lease recovery alone does not advance the failure state toward retirement', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    const entryId = `dispatch/${run.runId}`;

    // Claim the dispatch-run entry, let its lease expire, and repeat --
    // simulating a drain process that crashes immediately after claiming,
    // before ever attempting a single GitHub call. `attempts` climbs with
    // every recovery, but `settleOutbox` (and therefore
    // `firstFailedAt`/`nextAttemptAt`) is never touched.
    for (let i = 0; i < 25; i += 1) {
      const [claimed] = await store.claimPendingOutbox({
        limit: 1,
        now: clock.now(),
        leaseExpiresAt: new Date(
          Date.parse(clock.now()) + OUTBOX_LEASE_MS,
        ).toISOString(),
      });
      expect(claimed?.entryId).toBe(entryId);
      expect(claimed?.firstFailedAt).toBeUndefined();
      expect(claimed?.nextAttemptAt).toBeUndefined();
      clock.advanceMinutes(6); // past OUTBOX_LEASE_MS, so it recovers again
    }

    // `attempts` is now 26 (well past the old `MAX_OUTBOX_DELIVERY_ATTEMPTS`
    // of 20), yet a real delivery attempt made right now is treated as this
    // entry's *first* failure: it is not skipped for backoff, and not
    // retired -- both of which would only be possible if some earlier
    // recovery above had wrongly advanced the failure state.
    const failing = fakeFetch(500);
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: failing.fetchImpl,
      now: () => clock.now(),
    });
    expect(failing.calls.length).toBe(1);
    expect(result.failed).toEqual([
      { entryId, error: expect.stringContaining('500') },
    ]);

    // Decisively: it was released back to `pending`, not retired -- if the
    // 25 lease recoveries above had wrongly counted toward retirement (via
    // the polluted `attempts` counter, already past the old 20-claim cap),
    // this single real failure would have retired it immediately instead.
    // Confirm by letting backoff elapse and successfully delivering it.
    clock.advanceMinutes(OUTBOX_BACKOFF_BASE_MS / 60_000 + 1);
    const retry = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(204).fetchImpl,
      now: () => clock.now(),
    });
    expect(retry.dispatched).toEqual([run.runId]);
  });
});

// #1548's fix releases a backlog of report-outcome entries up to six days
// old across several repos the moment it deploys. Maintainer decision:
// deliver an entry only if its anchor issue/PR is still open; retire it
// (to the same terminal `failed` state the attempt-cap retirement above
// uses, but with a distinct 'anchor-closed' log reason) if the anchor has
// since closed -- a stale outcome report on a resolved issue is noise, and
// delivery is the outward-facing act. This is an outward-facing-delivery
// decision, not a technical constraint.
describe('drainOutbox: stale report-outcome anchor check (#1548)', () => {
  /** A GitHub-anchored run for `issue`, dispatched and reported `finished`,
   *  so it has exactly one pending `report-outcome` entry left -- the same
   *  shape as the fairness-block `reportedRun` helper above, but local to
   *  this describe block. */
  async function reportedRun(
    orchestrator: Orchestrator,
    store: MemoryStore,
    issue: number,
  ): Promise<string> {
    const requested = await orchestrator.request({
      taskId: { repo: 'octo/example', issue },
      requestId: `req-${issue}`,
      pipeline: 'claude',
    });
    if (isRefusal(requested)) throw new Error('unexpected refusal');
    const run = decidedRun(requested);
    await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl: fakeFetch(204).fetchImpl,
    });
    const reported = await orchestrator.report(run.runId, { ok: true });
    if (isRefusal(reported)) throw new Error('unexpected refusal');
    return run.runId;
  }

  /** Routes the anchor lookup (`GET .../issues/<n>`, no trailing path
   *  segment -- unlike the outcome comment's `.../issues/<n>/comments`) to
   *  a given `state`; every other call (the outcome comment POST) succeeds
   *  with 201. */
  function anchorAwareFetch(anchorState: 'open' | 'closed'): {
    fetchImpl: typeof fetch;
    calls: FetchCall[];
  } {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (/\/issues\/\d+$/u.test(url)) {
        return new Response(JSON.stringify({ state: anchorState }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  // 25 hours: strictly past `OUTBOX_STALE_REPORT_AGE_MS` (24 hours) without
  // depending on its exact value at runtime -- computing the advance from
  // the imported constant would make a RED run (against a revision that
  // doesn't export it yet) fail with an unrelated `Invalid time value`
  // instead of a real assertion failure. `expect(OUTBOX_STALE_REPORT_AGE_MS)
  // .toBeLessThan(...)` below still ties this fixed margin back to the
  // real constant, so a future threshold change past a day breaks loudly
  // here instead of silently under-advancing the clock.
  const PAST_STALE_THRESHOLD_MINUTES = 25 * 60;

  /** Strictly past `OUTBOX_STALE_REPORT_AGE_MS`. */
  function advancePastStaleThreshold(clock: Clock): void {
    clock.advanceMinutes(PAST_STALE_THRESHOLD_MINUTES);
  }

  it('sanity: the fixed 25h margin used above is actually past OUTBOX_STALE_REPORT_AGE_MS', () => {
    expect(OUTBOX_STALE_REPORT_AGE_MS).toBeLessThan(
      PAST_STALE_THRESHOLD_MINUTES * 60_000,
    );
  });

  it('retires a stale report-outcome entry without delivering when its anchor has closed', async () => {
    const { clock, store, orchestrator } = fixture();
    const runId = await reportedRun(orchestrator, store, 301);
    advancePastStaleThreshold(clock);

    const { fetchImpl, calls } = anchorAwareFetch('closed');
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

    expect(result.reported).toEqual([]);
    expect(result.failed).toEqual([
      {
        entryId: `outcome/${runId}`,
        error: expect.stringContaining('closed'),
      },
    ]);
    // The anchor lookup happened, but the outcome comment was never posted.
    expect(calls.some((c) => c.url.endsWith('/comments'))).toBe(false);

    // Retired to the terminal `failed` state, same as the attempt-cap
    // retirement above -- a later drain finds nothing left to claim for
    // it, and never calls GitHub again.
    const callsBefore = calls.length;
    const again = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });
    expect(again).toEqual({ dispatched: [], reported: [], failed: [] });
    expect(calls.length).toBe(callsBefore);
  });

  it('delivers a stale report-outcome entry normally when its anchor is still open', async () => {
    const { clock, store, orchestrator } = fixture();
    const runId = await reportedRun(orchestrator, store, 302);
    advancePastStaleThreshold(clock);

    const { fetchImpl, calls } = anchorAwareFetch('open');
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

    expect(result.reported).toEqual([runId]);
    expect(result.failed).toEqual([]);
    // The anchor lookup (GET) plus the outcome comment (POST): checking
    // does not replace delivery when the anchor is still open.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/comments'))).toBe(true);
  });

  it('delivers a fresh report-outcome entry with no anchor lookup at all', async () => {
    const { clock, store, orchestrator } = fixture();
    const runId = await reportedRun(orchestrator, store, 303);
    // No clock advance -- this entry is well under
    // OUTBOX_STALE_REPORT_AGE_MS, so it should never trigger the check.
    // `anchorState: 'closed'` proves that: if the lookup ran, it would see
    // a closed anchor and retire the entry instead of delivering it.
    const { fetchImpl, calls } = anchorAwareFetch('closed');
    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

    expect(result.reported).toEqual([runId]);
    // Only the comment POST -- no GET to the issue itself. Proves the
    // anchor lookup was never called for a fresh entry, not just that it
    // came back "open".
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith('/comments')).toBe(true);
  });

  it('leaves a stale entry deliverable, rather than dropping it, when the anchor lookup itself throws', async () => {
    const { clock, store, orchestrator } = fixture();
    const runId = await reportedRun(orchestrator, store, 304);
    advancePastStaleThreshold(clock);

    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (/\/issues\/\d+$/u.test(url)) {
        throw new Error('network exploded');
      }
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const result = await drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });

    // Not retired (not in `failed`) and not silently dropped: the lookup
    // failure defers to normal delivery, which goes on to succeed exactly
    // as it would for a confirmed-open anchor.
    expect(result.failed).toEqual([]);
    expect(result.reported).toEqual([runId]);
    expect(calls.some((c) => c.url.endsWith('/comments'))).toBe(true);
  });
});
