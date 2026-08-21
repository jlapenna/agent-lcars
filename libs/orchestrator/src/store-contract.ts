import { describe, expect, it } from 'vitest';

import {
  cancelRun,
  confirmDispatch,
  isQueued,
  isRefusal,
  requestRun,
} from './decide';
import type { LeasedOutboxEntry, TaskId } from './model';
import { type Clock, Orchestrator } from './orchestrator';
import {
  type OrchestratorStore,
  OUTBOX_LEASE_MS,
  StoreConflict,
} from './store';

const TASK: TaskId = { repo: 'octo/example', issue: 7 };
const T0 = '2026-08-15T12:00:00.000Z';

class TestClock implements Clock {
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

async function started(orchestrator: Orchestrator, requestId = 'req-1') {
  const outcome = await orchestrator.request({
    taskId: TASK,
    requestId,
    pipeline: 'claude',
  });
  if (isRefusal(outcome)) {
    throw new Error(`unexpected refusal: ${outcome.reason}`);
  }
  return outcome;
}

function claimOutbox(store: OrchestratorStore, now: string, limit = 10) {
  return store.claimPendingOutbox({
    limit,
    now,
    leaseExpiresAt: new Date(Date.parse(now) + OUTBOX_LEASE_MS).toISOString(),
  });
}

function onlyClaim(entries: readonly LeasedOutboxEntry[]): LeasedOutboxEntry {
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (entry === undefined) throw new Error('expected one outbox claim');
  return entry;
}

/**
 * Behavioural contract every `OrchestratorStore` implementation must
 * satisfy. Run this against `MemoryStore` (the reference implementation)
 * and against any other implementation (e.g. `FirestoreStore`) to prove
 * they agree on observable behaviour, independent of the decision layer
 * tests in `orchestrator.spec.ts` which only ever exercise `MemoryStore`.
 */
export function runOrchestratorStoreContract(
  name: string,
  makeStore: () => OrchestratorStore | Promise<OrchestratorStore>,
): void {
  describe(`OrchestratorStore contract: ${name}`, () => {
    async function fixture() {
      const clock = new TestClock(T0);
      const store = await makeStore();
      const orchestrator = new Orchestrator(store, clock);
      return { clock, store, orchestrator };
    }

    describe('the per-task mutex', () => {
      it('starts a run, takes the lock, and enqueues its dispatch', async () => {
        const { store, orchestrator } = await fixture();
        const outcome = await started(orchestrator);
        expect(outcome.run.state).toBe('pending');
        expect(outcome.task.activeRunId).toBe(outcome.run.runId);
        expect(await store.readActiveRun(TASK)).toMatchObject({
          runId: outcome.run.runId,
        });
      });

      it('refuses a second request while a run is live', async () => {
        const { orchestrator } = await fixture();
        await started(orchestrator, 'req-1');
        const second = await orchestrator.request({
          taskId: TASK,
          requestId: 'req-2',
          pipeline: 'claude',
        });
        expect(second).toMatchObject({ refused: true, reason: 'task-busy' });
      });

      it('maps a retried request to the existing run instead of a new one', async () => {
        const { orchestrator } = await fixture();
        const first = await started(orchestrator, 'req-1');
        const retry = await orchestrator.request({
          taskId: TASK,
          requestId: 'req-1',
          pipeline: 'claude',
        });
        expect(retry).toMatchObject({
          refused: true,
          reason: 'duplicate-request',
          existingRun: expect.objectContaining({ runId: first.run.runId }),
        });
      });

      it('frees the task after each terminal state so it can be worked again', async () => {
        const { clock, orchestrator } = await fixture();
        // finished -> free
        const first = await started(orchestrator, 'req-1');
        await orchestrator.confirmDispatch(first.run.runId);
        await orchestrator.report(first.run.runId, { ok: true });
        const second = await started(orchestrator, 'req-2');
        expect(second.run.runId).not.toBe(first.run.runId);
        // canceled -> free
        await orchestrator.cancel(second.run.runId, 'operator said stop');
        const third = await started(orchestrator, 'req-3');
        // lost -> each loss auto-retries until the budget
        // (MAX_AUTO_RETRIES = 2) is exhausted, which is when the task is
        // actually free again.
        for (let i = 0; i < 3; i++) {
          clock.advanceMinutes(121);
          await orchestrator.sweepExpired();
        }
        const fourth = await started(orchestrator, 'req-4');
        expect(fourth.run.runId).not.toBe(third.run.runId);
      });
    });

    describe('the auto-retry budget (consecutiveLost)', () => {
      it('increments consecutiveLost on loss and resets it on a later finish', async () => {
        const { clock, store, orchestrator } = await fixture();
        await started(orchestrator, 'req-1');
        clock.advanceMinutes(121);
        const swept = await orchestrator.sweepExpired();
        expect(swept.retried).toHaveLength(1);

        const afterLoss = await store.readTask(TASK);
        expect(afterLoss?.task.consecutiveLost).toBe(1);

        const retriedRunId = swept.retried[0]?.newRunId;
        if (retriedRunId === undefined) throw new Error('expected a retry');
        await orchestrator.confirmDispatch(retriedRunId);
        await orchestrator.report(retriedRunId, { ok: true });

        const afterFinish = await store.readTask(TASK);
        expect(afterFinish?.task.consecutiveLost).toBeUndefined();
      });
    });

    describe('queueing (opt-in)', () => {
      it('round-trips a queued pendingRequest through the store, and clears it once the settle path consumes it', async () => {
        const { store, orchestrator } = await fixture();
        const first = await started(orchestrator, 'req-1');
        const queued = await orchestrator.request({
          taskId: TASK,
          requestId: 'req-2',
          pipeline: 'codex',
          params: { mode: 'reply' },
          queueIfBusy: true,
        });
        if (isRefusal(queued)) throw new Error('unexpected refusal');
        if (!isQueued(queued)) throw new Error('expected a queued outcome');

        const afterQueue = await store.readTask(TASK);
        expect(afterQueue?.task.pendingRequest).toEqual({
          requestId: 'req-2',
          pipeline: 'codex',
          params: { mode: 'reply' },
        });
        // Queueing itself never starts a run: still just the one live run.
        expect(await store.listRuns(TASK)).toHaveLength(1);

        const settled = await orchestrator.report(first.run.runId, {
          ok: true,
        });
        if (isRefusal(settled)) throw new Error('unexpected refusal');
        const followUpRunId = settled.followUpRun?.runId;
        if (followUpRunId === undefined) {
          throw new Error('expected a follow-up run');
        }

        const afterSettle = await store.readTask(TASK);
        expect(afterSettle?.task.pendingRequest).toBeUndefined();
        expect(afterSettle?.task.activeRunId).toBe(followUpRunId);
        expect(await store.readRun(followUpRunId)).toMatchObject({
          requestId: 'req-2',
          pipeline: 'codex',
          params: { mode: 'reply' },
          state: 'pending',
        });
        expect((await store.readActiveRun(TASK))?.runId).toBe(followUpRunId);
      });
    });

    describe('apply is a compare-and-set on the task revision', () => {
      it('rejects a second apply computed from the same (absent) revision', async () => {
        const { store } = await fixture();
        const winner = requestRun({
          now: T0,
          task: undefined,
          taskId: TASK,
          activeRun: undefined,
          requestId: 'req-a',
          pipeline: 'claude',
        });
        const loser = requestRun({
          now: T0,
          task: undefined,
          taskId: TASK,
          activeRun: undefined,
          requestId: 'req-b',
          pipeline: 'claude',
        });
        if (isRefusal(winner) || isRefusal(loser)) {
          throw new Error('unexpected refusal');
        }
        await store.apply({ decision: winner, expectedRevision: undefined });
        await expect(
          store.apply({ decision: loser, expectedRevision: undefined }),
        ).rejects.toThrow(StoreConflict);
        // The loser never landed: the winner's run still holds the lock.
        expect((await store.readActiveRun(TASK))?.runId).toBe(winner.run.runId);
      });

      it('rejects a second apply computed from the same non-zero revision', async () => {
        const { store, orchestrator } = await fixture();
        const first = await started(orchestrator, 'req-1');
        const versioned = await store.readTask(TASK);
        if (versioned === undefined) throw new Error('expected task to exist');
        expect(versioned.revision).toBe(1);

        // Two independent decisions, both computed against the same
        // (task, run, revision) snapshot -- exactly what two racing
        // callers would each produce from one shared read.
        const confirmed = confirmDispatch({
          now: T0,
          task: versioned.task,
          run: first.run,
        });
        const canceled = cancelRun({
          now: T0,
          task: versioned.task,
          run: first.run,
        });
        if (isRefusal(confirmed) || isRefusal(canceled)) {
          throw new Error('unexpected refusal');
        }

        await store.apply({
          decision: confirmed,
          expectedRevision: versioned.revision,
        });
        await expect(
          store.apply({
            decision: canceled,
            expectedRevision: versioned.revision,
          }),
        ).rejects.toThrow(StoreConflict);
        // The loser never landed: the winner's transition stuck.
        expect((await store.readRun(first.run.runId))?.state).toBe('running');
      });
    });

    describe('the outbox', () => {
      it('gives exactly one of two concurrent claimants each entry', async () => {
        const { clock, store, orchestrator } = await fixture();
        await started(orchestrator);

        const [first, second] = await Promise.all([
          claimOutbox(store, clock.now()),
          claimOutbox(store, clock.now()),
        ]);
        const claimed = [...first, ...second];
        expect(claimed).toHaveLength(1);
        expect(claimed[0]).toMatchObject({
          kind: 'dispatch-run',
          state: 'leased',
          attempts: 1,
        });
        expect(await claimOutbox(store, clock.now())).toEqual([]);

        const entry = onlyClaim(claimed);
        expect(
          await store.settleOutbox({
            entryId: entry.entryId,
            claimId: entry.claimId,
            state: 'done',
            now: clock.now(),
          }),
        ).toBe(true);
        expect(await claimOutbox(store, clock.now())).toEqual([]);
      });

      it('recovers an expired lease and fences the stale claimant', async () => {
        const { clock, store, orchestrator } = await fixture();
        await started(orchestrator);
        const first = onlyClaim(await claimOutbox(store, clock.now()));

        clock.advanceMinutes(6);
        const recovered = onlyClaim(await claimOutbox(store, clock.now()));
        expect(recovered.entryId).toBe(first.entryId);
        expect(recovered.claimId).not.toBe(first.claimId);
        expect(recovered.attempts).toBe(2);

        expect(
          await store.settleOutbox({
            entryId: first.entryId,
            claimId: first.claimId,
            state: 'done',
            now: clock.now(),
          }),
        ).toBe(false);
        expect(await claimOutbox(store, clock.now())).toEqual([]);
        expect(
          await store.settleOutbox({
            entryId: recovered.entryId,
            claimId: recovered.claimId,
            state: 'done',
            now: clock.now(),
          }),
        ).toBe(true);
      });

      it('releases an explicit failure for immediate retry', async () => {
        const { clock, store, orchestrator } = await fixture();
        await started(orchestrator);
        const first = onlyClaim(await claimOutbox(store, clock.now()));
        expect(
          await store.settleOutbox({
            entryId: first.entryId,
            claimId: first.claimId,
            state: 'pending',
            now: clock.now(),
          }),
        ).toBe(true);

        const retry = onlyClaim(await claimOutbox(store, clock.now()));
        expect(retry.entryId).toBe(first.entryId);
        expect(retry.claimId).not.toBe(first.claimId);
        expect(retry.attempts).toBe(2);
      });
    });

    describe('expired-run listing', () => {
      it('lists a live run only once its lease has passed, and excludes a renewed one', async () => {
        const { clock, store, orchestrator } = await fixture();
        const kept = await started(orchestrator, 'req-1');
        await orchestrator.confirmDispatch(kept.run.runId);
        clock.advanceMinutes(80);
        await orchestrator.renew(kept.run.runId);
        clock.advanceMinutes(80); // 160m total; renewal at 80m covers to 200m
        expect(await store.listExpiredRuns(clock.now())).toEqual([]);

        clock.advanceMinutes(44); // 204m total; renewed lease covered only to 200m
        const expired = await store.listExpiredRuns(clock.now());
        expect(expired.map((run) => run.runId)).toEqual([kept.run.runId]);
      });
    });

    describe('live-run listing', () => {
      it('lists a live run regardless of its lease, and drops it once settled', async () => {
        const { clock, store, orchestrator } = await fixture();
        const live = await started(orchestrator, 'req-1');
        await orchestrator.confirmDispatch(live.run.runId);

        // Nowhere near its lease, so the expiry feed is empty -- but the
        // live feed still has it. That difference is the whole reason this
        // method exists (#1361): a terminal executor is settled on the
        // evidence, not on the lease.
        clock.advanceMinutes(1);
        expect(await store.listExpiredRuns(clock.now())).toEqual([]);
        expect((await store.listLiveRuns()).map((run) => run.runId)).toEqual([
          live.run.runId,
        ]);

        await orchestrator.report(live.run.runId, { ok: true });
        expect(await store.listLiveRuns()).toEqual([]);
      });
    });

    describe('a stale run can never overwrite its successor', () => {
      it('refuses a renew from a run that already lost the lock, after a fresh run took it', async () => {
        const { clock, store, orchestrator } = await fixture();
        const stale = await started(orchestrator, 'req-1');
        clock.advanceMinutes(121);
        // The task's lock is immediately handed to the auto-retry -- that's
        // the "fresh run" here, not a manual re-request (which would now be
        // refused as task-busy while the retry is live).
        const swept = await orchestrator.sweepExpired();
        const freshRunId = swept.retried[0]?.newRunId;
        if (freshRunId === undefined) throw new Error('expected an auto-retry');
        const late = await orchestrator.renew(stale.run.runId);
        expect(isRefusal(late)).toBe(true);
        expect((await store.readActiveRun(TASK))?.runId).toBe(freshRunId);
      });
    });
  });
}
