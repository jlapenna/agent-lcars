import { describe, expect, it } from 'vitest';

import {
  cancelRun,
  confirmDispatch,
  decidedRun,
  isRefusal,
  requestRun,
} from './decide';
import type { LeasedOutboxEntry, TaskId } from './model';
import { type Clock, Orchestrator } from './orchestrator';
import type { Schedule, ScheduleStore } from './schedule-store';
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

/** `request()` always mints a run, so callers can rely on `.run` directly
 *  instead of narrowing it at every call site. */
async function started(orchestrator: Orchestrator, requestId = 'req-1') {
  const outcome = await orchestrator.request({
    taskId: TASK,
    requestId,
    pipeline: 'claude',
  });
  if (isRefusal(outcome)) {
    throw new Error(`unexpected refusal: ${outcome.reason}`);
  }
  return { ...outcome, run: decidedRun(outcome) };
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
        expect((await store.readActiveRun(TASK))?.runId).toBe(
          decidedRun(winner).runId,
        );
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

    it('applies a decision that carries no run (closeTask)', async () => {
      const store = await makeStore();
      const id: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };
      const now = '2026-08-15T12:00:00.000Z';
      await store.apply({
        decision: {
          task: { task: id, runCount: 0, closedAt: now, updatedAt: now },
          outbox: [],
        },
        expectedRevision: undefined,
      });
      const read = await store.readTask(id);
      expect(read?.task.closedAt).toBe(now);
      expect(await store.listRuns(id)).toEqual([]);
    });

    it('lists runs for a native anchor and keeps anchors apart', async () => {
      const { store, orchestrator } = await fixture();
      const work: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };
      const issue: TaskId = { repo: 'octo/example', issue: 7 };
      await orchestrator.request({
        taskId: work,
        requestId: 'w1',
        pipeline: 'claude',
        work: {},
      });
      await orchestrator.request({
        taskId: issue,
        requestId: 'i1',
        pipeline: 'claude',
      });
      expect((await store.listRuns(work)).map((r) => r.runId)).toEqual([
        'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      ]);
      expect((await store.listRuns(issue)).map((r) => r.runId)).toEqual([
        'octo/example#7/r1',
      ]);
    });

    it('round-trips work and closedAt on a native task', async () => {
      const { store, orchestrator } = await fixture();
      const work: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3H' };
      await orchestrator.request({
        taskId: work,
        requestId: 'w1',
        pipeline: 'claude',
        work: { origin: { principal: 'user:jlapenna' } },
      });
      await orchestrator.report('work:01J5Z3K9QX8F0N2B4V6C8D1E3H/r1', {
        ok: false,
      });
      await orchestrator.close(work);
      const read = await store.readTask(work);
      expect(read?.task.work).toEqual({
        origin: { principal: 'user:jlapenna' },
      });
      expect(read?.task.closedAt).toBe('2026-08-15T12:00:00.000Z');
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

    describe('native-task listing', () => {
      it('lists native anchors only, never GitHub-anchored tasks', async () => {
        const { store, orchestrator } = await fixture();
        const workId = '01J5Z3K9QX8F0N2B4V6C8D1E3G';

        await orchestrator.request({
          taskId: { workId },
          requestId: workId,
          pipeline: 'claude',
          work: { origin: { principal: 'user:jlapenna' } },
        });
        await started(orchestrator, 'req-github');

        const native = await store.listNativeTasks();

        expect(native.map((entry) => entry.task.task)).toEqual([{ workId }]);
        expect(native[0]?.revision).toBe(1);
      });

      it('orders newest-first and honors a limit', async () => {
        const { store, orchestrator } = await fixture();
        // Ascending ULIDs, requested in ascending order -- "newest" here
        // means "sorts last", exactly what real ULIDs guarantee for tasks
        // created in order.
        const workA = '01J5Z3K9QX8F0N2B4V6C8D1E3A';
        const workB = '01J5Z3K9QX8F0N2B4V6C8D1E3B';
        const workC = '01J5Z3K9QX8F0N2B4V6C8D1E3C';
        for (const workId of [workA, workB, workC]) {
          await orchestrator.request({
            taskId: { workId },
            requestId: workId,
            pipeline: 'claude',
            work: { origin: { principal: 'user:jlapenna' } },
          });
        }

        const all = await store.listNativeTasks();
        expect(all.map((entry) => entry.task.task)).toEqual([
          { workId: workC },
          { workId: workB },
          { workId: workA },
        ]);

        const limited = await store.listNativeTasks(2);
        expect(limited.map((entry) => entry.task.task)).toEqual([
          { workId: workC },
          { workId: workB },
        ]);
      });
    });

    describe('the queue claim state', () => {
      // WORK_ID_RE (model.ts) requires exactly 26 Crockford base32
      // characters, excluding I, L, O, U. Deriving the id straight from
      // `requestId` (e.g. 'q1', 'q2') would fail that regex, so this pulls
      // out only the digits and pads them into a fixed, charset-safe id.
      function queueWorkId(requestId: string): string {
        const digits = requestId.replace(/\D/gu, '').padStart(16, '0');
        return `01TESTQVEV${digits}`;
      }

      async function queuedRun(orchestrator: Orchestrator, requestId: string) {
        const outcome = await orchestrator.request({
          taskId: { workId: queueWorkId(requestId) },
          requestId,
          pipeline: 'claude',
          executor: 'queue',
        });
        if (isRefusal(outcome)) throw new Error('unexpected refusal');
        return decidedRun(outcome);
      }

      it('enqueueRun is idempotent and listQueuedRuns finds it', async () => {
        const { store, orchestrator } = await fixture();
        const run = await queuedRun(orchestrator, 'q1');
        await store.enqueueRun({ runId: run.runId, now: T0 });
        await store.enqueueRun({ runId: run.runId, now: T0 }); // idempotent
        const queued = await store.listQueuedRuns();
        expect(queued.map((r) => r.runId)).toEqual([run.runId]);
        expect(queued[0]?.queue).toEqual({ state: 'queued' });
      });

      it('claimQueuedRun picks the oldest queued run for a matching pipeline', async () => {
        const { store, orchestrator, clock } = await fixture();
        const first = await queuedRun(orchestrator, 'q1');
        await store.enqueueRun({ runId: first.runId, now: T0 });
        clock.advanceMinutes(1);
        const second = await queuedRun(orchestrator, 'q2');
        await store.enqueueRun({ runId: second.runId, now: clock.now() });

        const claimed = await store.claimQueuedRun({
          pipelines: ['claude'],
          now: clock.now(),
          claimedBy: 'runner-1',
          tokenHash: 'b'.repeat(64),
        });
        expect(claimed?.runId).toBe(first.runId);
        expect(claimed?.queue).toMatchObject({
          state: 'claimed',
          claimedBy: 'runner-1',
          tokenHash: 'b'.repeat(64),
        });
      });

      it('a claimed run is never returned by a second claim', async () => {
        const { store, orchestrator } = await fixture();
        const run = await queuedRun(orchestrator, 'q1');
        await store.enqueueRun({ runId: run.runId, now: T0 });
        await store.claimQueuedRun({
          pipelines: ['claude'],
          now: T0,
          claimedBy: 'runner-1',
          tokenHash: 'c'.repeat(64),
        });
        const second = await store.claimQueuedRun({
          pipelines: ['claude'],
          now: T0,
          claimedBy: 'runner-2',
          tokenHash: 'd'.repeat(64),
        });
        expect(second).toBeUndefined();
      });

      it('claimQueuedRun ignores a non-matching pipeline', async () => {
        const { store, orchestrator } = await fixture();
        const run = await queuedRun(orchestrator, 'q1');
        await store.enqueueRun({ runId: run.runId, now: T0 });
        const claimed = await store.claimQueuedRun({
          pipelines: ['codex'],
          now: T0,
          claimedBy: 'runner-1',
          tokenHash: 'e'.repeat(64),
        });
        expect(claimed).toBeUndefined();
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

const SCHEDULE_T0 = '2026-08-15T12:00:00.000Z';

/**
 * Behavioural contract every `ScheduleStore` implementation must satisfy,
 * parallel to {@link runOrchestratorStoreContract} but for schedules,
 * which have no mutex and no version guard -- see `schedule-store.ts`'s
 * `writeSchedule` doc for why last-write-wins is acceptable here.
 */
export function runScheduleStoreContract(
  name: string,
  makeStore: () => ScheduleStore | Promise<ScheduleStore>,
): void {
  describe(`ScheduleStore contract: ${name}`, () => {
    function schedule(over: Partial<Schedule> = {}): Schedule {
      return {
        scheduleId: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
        cron: '*/15 * * * *',
        spec: { title: 't' },
        enabled: true,
        createdBy: 'user:jlapenna',
        createdAt: SCHEDULE_T0,
        updatedAt: SCHEDULE_T0,
        ...over,
      };
    }

    it('round-trips a written schedule', async () => {
      const store = await makeStore();
      await store.writeSchedule(schedule());
      expect(await store.readSchedule('01J5Z3K9QX8F0N2B4V6C8D1E3G')).toEqual(
        schedule(),
      );
    });

    it('round-trips a schedule with all three optional fields set', async () => {
      const store = await makeStore();
      const withOptionals = schedule({
        lastSlotAt: SCHEDULE_T0,
        lastItemId: '01J5Z3K9QX8F0N2B4V6C8D1E3H',
        disabledReason: 'grant-revoked',
      });
      await store.writeSchedule(withOptionals);
      expect(await store.readSchedule('01J5Z3K9QX8F0N2B4V6C8D1E3G')).toEqual(
        withOptionals,
      );
    });

    it('reads undefined for an unknown schedule', async () => {
      const store = await makeStore();
      expect(await store.readSchedule('missing')).toBeUndefined();
    });

    it('overwrites on a second write (last write wins)', async () => {
      const store = await makeStore();
      await store.writeSchedule(schedule());
      await store.writeSchedule(schedule({ enabled: false }));
      expect(
        (await store.readSchedule('01J5Z3K9QX8F0N2B4V6C8D1E3G'))?.enabled,
      ).toBe(false);
    });

    it('lists newest first and honors a limit', async () => {
      const store = await makeStore();
      const ids = [
        '01J5Z3K9QX8F0N2B4V6C8D1E3A',
        '01J5Z3K9QX8F0N2B4V6C8D1E3B',
        '01J5Z3K9QX8F0N2B4V6C8D1E3C',
      ];
      for (const scheduleId of ids) {
        await store.writeSchedule(schedule({ scheduleId }));
      }
      expect((await store.listSchedules()).map((s) => s.scheduleId)).toEqual(
        [...ids].reverse(),
      );
      expect((await store.listSchedules(2)).map((s) => s.scheduleId)).toEqual([
        '01J5Z3K9QX8F0N2B4V6C8D1E3C',
        '01J5Z3K9QX8F0N2B4V6C8D1E3B',
      ]);
    });

    it('lists only enabled schedules', async () => {
      const store = await makeStore();
      await store.writeSchedule(
        schedule({ scheduleId: '01J5Z3K9QX8F0N2B4V6C8D1E3D', enabled: true }),
      );
      await store.writeSchedule(
        schedule({
          scheduleId: '01J5Z3K9QX8F0N2B4V6C8D1E3E',
          enabled: false,
        }),
      );
      expect(
        (await store.listEnabledSchedules()).map((s) => s.scheduleId),
      ).toEqual(['01J5Z3K9QX8F0N2B4V6C8D1E3D']);
    });
  });
}
