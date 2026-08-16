import {
  isRefusal,
  MemoryStore,
  Orchestrator,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import { drainOutbox } from './orchestrator-dispatch';

const TASK: TaskId = { repo: 'octo/example', issue: 7 };
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

describe('drainOutbox: dispatch-run', () => {
  it('dispatches a pending run and confirms it', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    const { fetchImpl, calls } = fakeFetch(204);

    const result = await drainOutbox({
      store,
      orchestrator,
      githubToken: TOKEN,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
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
        'issue',
        'mode',
        'reply',
      ].sort(),
    );
    expect(inputs.issue).toBe('7');
    expect(inputs.mode).toBe('implement');
    expect(inputs.reply).toBe('');
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
      githubToken: TOKEN,
      fetchImpl,
    });
    expect(second.dispatched).toEqual([]);
    expect(calls).toHaveLength(1); // no additional fetch call
  });

  it('forwards mode/reply from run params verbatim', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator, 'req-1', {
      mode: 'reply',
      reply: 'thanks for the update',
    });
    const { fetchImpl, calls } = fakeFetch(204);

    await drainOutbox({ store, orchestrator, githubToken: TOKEN, fetchImpl });

    const inputs = callBody(calls[0]!).inputs as Record<string, string>;
    expect(inputs.mode).toBe('reply');
    expect(inputs.reply).toBe('thanks for the update');
    expect(inputs.broker_intent_id).toBe(run.runId);
  });

  it('leaves the entry pending and records a failure on a non-204 response, retrying later', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);

    const failing = fakeFetch(500);
    const first = await drainOutbox({
      store,
      orchestrator,
      githubToken: TOKEN,
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
      githubToken: TOKEN,
      fetchImpl: succeeding.fetchImpl,
    });

    expect(second.dispatched).toEqual([run.runId]);
    expect(second.failed).toEqual([]);
    expect((await store.readRun(run.runId))?.state).toBe('running');
  });

  it('settles a stale dispatch entry (run already finished) without any fetch call', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);

    // The run finishes (still legal from `pending`, before ever being
    // dispatched) before the dispatch-run entry is ever drained.
    const reportOutcome = await orchestrator.report(run.runId, { ok: true });
    if (isRefusal(reportOutcome)) {
      throw new Error(`unexpected refusal: ${reportOutcome.reason}`);
    }
    // Isolate the dispatch-run entry: settle the report-outcome entry that
    // came with it out of band so this drain call only sees the stale one.
    await store.settleOutbox(`outcome/${run.runId}`, 'done');

    const neverCalled = vi.fn<typeof fetch>();

    const result = await drainOutbox({
      store,
      orchestrator,
      githubToken: TOKEN,
      fetchImpl: neverCalled,
    });

    expect(neverCalled).not.toHaveBeenCalled();
    expect(result.dispatched).toEqual([]);
    expect(result.failed).toEqual([]);

    // Nothing left pending for a later drain either.
    const again = await drainOutbox({
      store,
      orchestrator,
      githubToken: TOKEN,
      fetchImpl: neverCalled,
    });
    expect(again.dispatched).toEqual([]);
    expect(again.failed).toEqual([]);
  });
});

describe('drainOutbox: report-outcome', () => {
  it('posts the finished outcome, including the ref, and settles', async () => {
    const { store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await drainOutbox({
      store,
      orchestrator,
      githubToken: TOKEN,
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
      githubToken: TOKEN,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/octo/example/issues/7/comments',
    );
    const body = callBody(calls[0]!).body as string;
    expect(body).toContain(`Run ${run.runId} finished.`);
    expect(body).toContain(ref);

    expect(result.reported).toEqual([run.runId]);
    expect(result.failed).toEqual([]);

    const second = await drainOutbox({
      store,
      orchestrator,
      githubToken: TOKEN,
      fetchImpl,
    });
    expect(second.reported).toEqual([]);
    expect(calls).toHaveLength(1); // no additional fetch call
  });

  it('posts the lost-run comment body after a lease-expiry sweep', async () => {
    const { clock, store, orchestrator } = fixture();
    const { run } = await started(orchestrator);
    await drainOutbox({
      store,
      orchestrator,
      githubToken: TOKEN,
      fetchImpl: fakeFetch(204).fetchImpl,
    });

    clock.advanceMinutes(121);
    const settled = await orchestrator.sweepExpired();
    expect(settled.map((r) => r.state)).toEqual(['lost']);

    const { fetchImpl, calls } = fakeFetch(201);
    const result = await drainOutbox({
      store,
      orchestrator,
      githubToken: TOKEN,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/octo/example/issues/7/comments',
    );
    const body = callBody(calls[0]!).body as string;
    expect(body).toBe(
      `⚠️ Run ${run.runId} was lost (no report before its lease expired). ` +
        `The task is unlocked; re-request to try again.`,
    );
    expect(result.reported).toEqual([run.runId]);
  });
});
