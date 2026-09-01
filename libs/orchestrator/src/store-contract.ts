import { describe, expect, it } from 'vitest';

import {
  cancelRun,
  confirmDispatch,
  decidedRun,
  isRefusal,
  requestRun,
} from './decide';
import {
  type LeasedOutboxEntry,
  type TaskId,
  taskKey,
  WORK_PAYLOAD_MAX_BYTES,
} from './model';
import { type Clock, Orchestrator } from './orchestrator';
import type { Schedule, ScheduleStore } from './schedule-store';
import {
  type OrchestratorStore,
  OUTBOX_LEASE_MS,
  StoreConflict,
} from './store';

const TASK: TaskId = { repo: 'octo/example', issue: 7 };
const T0 = '2026-08-15T12:00:00.000Z';
const TASK_WORK = { spec: { title: 'contract work' } };

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
    work: TASK_WORK,
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

      it('durably binds only the first source request to a canonical identity', async () => {
        const { store, orchestrator } = await fixture();
        const canonical = await started(orchestrator, 'canonical-request');
        await orchestrator.report(canonical.run.runId, { ok: true });
        const requestBinding = {
          bindingKey: 'shared-intake-binding',
          canonicalRequestId: 'canonical-request',
        } as const;
        const firstDelivery = await orchestrator.request({
          taskId: TASK,
          requestId: 'first-source-delivery',
          pipeline: 'claude',
          requestBinding,
        });
        expect(firstDelivery).toMatchObject({
          refused: true,
          reason: 'duplicate-request',
          existingRun: expect.objectContaining({ runId: canonical.run.runId }),
        });

        const retry = await orchestrator.request({
          taskId: TASK,
          requestId: 'first-source-delivery',
          pipeline: 'claude',
          requestBinding,
        });
        expect(retry).toMatchObject({
          refused: true,
          reason: 'duplicate-request',
          existingRun: expect.objectContaining({ runId: canonical.run.runId }),
        });

        const laterDelivery = await orchestrator.request({
          taskId: TASK,
          requestId: 'later-source-delivery',
          pipeline: 'claude',
          requestBinding,
        });
        expect(laterDelivery).toMatchObject({
          run: expect.objectContaining({
            requestId: 'later-source-delivery',
          }),
        });
        expect(await store.listRuns(TASK)).toHaveLength(2);
      });

      it('atomically converges a canonical writer and first bound source', async () => {
        const { store, orchestrator } = await fixture();
        const requestBinding = {
          bindingKey: 'concurrent-shared-intake-binding',
          canonicalRequestId: 'canonical-request',
        } as const;
        const [canonical, firstSource] = await Promise.all([
          orchestrator.request({
            taskId: TASK,
            requestId: 'canonical-request',
            pipeline: 'claude',
            work: TASK_WORK,
          }),
          orchestrator.request({
            taskId: TASK,
            requestId: 'first-source-delivery',
            pipeline: 'claude',
            work: TASK_WORK,
            requestBinding,
          }),
        ]);
        const outcomes = [canonical, firstSource];
        expect(outcomes.filter((outcome) => !isRefusal(outcome))).toHaveLength(
          1,
        );
        expect(
          outcomes.filter(
            (outcome) =>
              isRefusal(outcome) && outcome.reason === 'duplicate-request',
          ),
        ).toHaveLength(1);
        expect(await store.listRuns(TASK)).toHaveLength(1);
      });

      it('atomically maps overlapping same-id requests to the sole run', async () => {
        const { store, orchestrator } = await fixture();
        const input = {
          taskId: TASK,
          requestId: 'same-request',
          pipeline: 'claude',
          work: TASK_WORK,
        };
        const [left, right] = await Promise.all([
          orchestrator.request(input),
          orchestrator.request(input),
        ]);
        const outcomes = [left, right];
        const accepted = outcomes.find((outcome) => !isRefusal(outcome));
        const duplicate = outcomes.find(
          (outcome) =>
            isRefusal(outcome) && outcome.reason === 'duplicate-request',
        );
        if (accepted === undefined || isRefusal(accepted)) {
          throw new Error('expected one accepted request');
        }
        expect(duplicate).toMatchObject({
          refused: true,
          reason: 'duplicate-request',
          existingRun: expect.objectContaining({
            runId: decidedRun(accepted).runId,
          }),
        });
        expect(await store.listRuns(TASK)).toHaveLength(1);
      });

      it('checks immutable Work within the overlapping first-request transaction', async () => {
        const { store, orchestrator } = await fixture();
        const workFor = (pipeline: 'claude' | 'codex') => ({
          spec: { title: 'immutable work', pipeline },
        });
        const request = (requestId: string, pipeline: 'claude' | 'codex') => {
          const work = workFor(pipeline);
          return orchestrator.request({
            taskId: TASK,
            requestId,
            pipeline,
            work,
            isStoredWorkCompatible: (stored) =>
              JSON.stringify(stored) === JSON.stringify(work),
          });
        };

        const [left, right] = await Promise.all([
          request('claude-first', 'claude'),
          request('codex-first', 'codex'),
        ]);
        const outcomes = [left, right];
        const accepted = outcomes.find((outcome) => !isRefusal(outcome));
        const mismatch = outcomes.find(
          (outcome) =>
            isRefusal(outcome) && outcome.reason === 'work-spec-mismatch',
        );
        if (accepted === undefined || isRefusal(accepted)) {
          throw new Error('expected one accepted request');
        }

        expect(mismatch).toMatchObject({
          refused: true,
          reason: 'work-spec-mismatch',
        });
        expect(await store.listRuns(TASK)).toHaveLength(1);
        expect(decidedRun(accepted).pipeline).toBe(
          (accepted.task.work as { spec: { pipeline: string } }).spec.pipeline,
        );
      });

      it('returns the terminal request-id match before a newer live run', async () => {
        const { store, orchestrator } = await fixture();
        const first = await started(orchestrator, 'terminal-retry');
        await orchestrator.report(first.run.runId, { ok: true });
        await started(orchestrator, 'newer-request');

        const replay = await orchestrator.request({
          taskId: TASK,
          requestId: 'terminal-retry',
          pipeline: 'claude',
        });
        expect(replay).toMatchObject({
          refused: true,
          reason: 'duplicate-request',
          existingRun: expect.objectContaining({ runId: first.run.runId }),
        });
        expect(await store.listRuns(TASK)).toHaveLength(2);
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
      it('keeps auto-retry history separate from arbitrary caller request IDs', async () => {
        const { clock, store, orchestrator } = await fixture();
        const { run } = await started(orchestrator, 'retry:octo/example#7/r1');
        clock.advanceMinutes(121);

        const swept = await orchestrator.sweepExpired();
        expect(swept.retried).toHaveLength(1);
        const retry = await store.readRun(swept.retried[0]?.newRunId as string);
        expect(retry).toMatchObject({
          requestId: `retry:${run.runId}`,
          requestSource: 'auto-retry',
        });

        const replay = await orchestrator.request({
          taskId: TASK,
          requestId: `retry:${run.runId}`,
          pipeline: run.pipeline,
        });
        expect(replay).toMatchObject({
          refused: true,
          reason: 'duplicate-request',
          existingRun: expect.objectContaining({ runId: run.runId }),
        });
      });

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
        expect(afterFinish?.task.consecutiveLost).toBe(0);
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
          work: TASK_WORK,
        });
        const loser = requestRun({
          now: T0,
          task: undefined,
          taskId: TASK,
          activeRun: undefined,
          requestId: 'req-b',
          pipeline: 'claude',
          work: TASK_WORK,
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
          task: {
            task: id,
            runCount: 0,
            consecutiveLost: 0,
            work: {},
            closedAt: now,
            updatedAt: now,
          },
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
        work: TASK_WORK,
      });
      expect((await store.listRuns(work)).map((r) => r.runId)).toEqual([
        'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      ]);
      expect((await store.listRuns(issue)).map((r) => r.runId)).toEqual([
        'octo/example#7/r1',
      ]);
    });

    it('lists a bounded newest-first global run feed across anchor kinds', async () => {
      const { clock, store, orchestrator } = await fixture();
      const issue: TaskId = { repo: 'octo/example', issue: 8 };
      const work: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };
      await orchestrator.request({
        taskId: issue,
        requestId: 'issue-recent',
        pipeline: 'claude',
        work: TASK_WORK,
      });
      clock.advanceMinutes(1);
      await orchestrator.request({
        taskId: work,
        requestId: 'work-recent',
        pipeline: 'opencode',
        work: {},
      });

      expect((await store.listRecentRuns(1)).map((run) => run.runId)).toEqual([
        'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      ]);
      expect((await store.listRecentRuns(2)).map((run) => run.runId)).toEqual([
        'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
        'octo/example#8/r1',
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

    // Missing fixture (final-review item 3/8): every other `work` fixture
    // in this file is a native (work-anchored) task with a trivial
    // payload. Nothing round-tripped a GITHUB-anchored task carrying a
    // real `WorkPayload`-shaped `work` -- the exact document shape
    // `work-from-github.ts`'s `workPayloadFromGithub` produces once a
    // GitHub-anchored task has one (sub-project 5) -- through a real
    // store (`MemoryStore` always; `FirestoreStore` too, when this
    // contract runs against the emulator). Sized at the real byte bound
    // `truncatedDescription`'s byte-aware clamp (item 3) exists to keep
    // out of storage -- see model.spec.ts's matching fixture for the
    // derivation of the exact character count.
    it('round-trips a GitHub-anchored work payload sized at the real byte bound', async () => {
      const { store, orchestrator } = await fixture();
      const work = {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'Fix the thing',
          description: '漢'.repeat(10_868),
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      };
      expect(new TextEncoder().encode(JSON.stringify(work)).length).toBe(
        WORK_PAYLOAD_MAX_BYTES,
      );

      await orchestrator.request({
        taskId: TASK,
        requestId: 'req-work-byte-bound',
        pipeline: 'claude',
        work,
      });

      const read = await store.readTask(TASK);
      expect(read?.task.work).toEqual(work);
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

      it('claims a never-attempted entry over a larger set of already-attempted, due entries (starvation)', async () => {
        const { clock, store, orchestrator } = await fixture();

        // Three already-attempted entries -- claimed once, then released
        // back to `pending` (immediately due again, no backoff at the
        // store layer) -- created first, so a claim order blind to
        // `attempts` (creation order, or any other order incidental to
        // storage) keeps re-selecting them ahead of anything created
        // later. This is the production shape: a recurring set of
        // already-failing entries crowding out ones that have never been
        // claimed even once.
        for (let issue = 101; issue <= 103; issue += 1) {
          const outcome = await orchestrator.request({
            taskId: { repo: 'octo/example', issue },
            requestId: `req-${issue}`,
            pipeline: 'claude',
            work: TASK_WORK,
          });
          if (isRefusal(outcome)) throw new Error('unexpected refusal');
          const claim = onlyClaim(await claimOutbox(store, clock.now(), 1));
          expect(
            await store.settleOutbox({
              entryId: claim.entryId,
              claimId: claim.claimId,
              state: 'pending',
              now: clock.now(),
            }),
          ).toBe(true);
        }

        // A fourth task's dispatch entry, created only now -- after all
        // three already-attempted ones -- and never yet claimed.
        const freshOutcome = await orchestrator.request({
          taskId: { repo: 'octo/example', issue: 104 },
          requestId: 'req-104',
          pipeline: 'claude',
          work: TASK_WORK,
        });
        if (isRefusal(freshOutcome)) throw new Error('unexpected refusal');

        // All four entries are due; the never-attempted one must win a
        // single claim, not lose to creation order.
        const claimed = onlyClaim(await claimOutbox(store, clock.now(), 1));
        expect(claimed.runId).toBe(decidedRun(freshOutcome).runId);
        expect(claimed.attempts).toBe(1);
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

      it('pages past `limit` via `before`, reaching an item the first page cannot see', async () => {
        // Issue #1546: `work-router.ts`'s `list` used to call this with
        // only `limit`, so anything past the newest `limit` native tasks
        // was invisible to every caller no matter how it filtered --
        // including a caller (sub-project 6's session-pin tick) looking
        // for a specific still-open item that happened to predate a busy
        // stretch of newer ones. `before` is the fix: page by the last
        // `workId` of the previous page until the store itself is
        // exhausted.
        const { store, orchestrator } = await fixture();
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

        // A `limit`-only read never reaches `workA`: it is the oldest of
        // three, and a page of 2 is entirely `workC`/`workB`.
        const firstPage = await store.listNativeTasks(2);
        expect(firstPage.map((entry) => entry.task.task)).toEqual([
          { workId: workC },
          { workId: workB },
        ]);

        // Paging with `before` set to the first page's last `workId`
        // reaches the item a single bounded read drops.
        const secondPage = await store.listNativeTasks(2, workB);
        expect(secondPage.map((entry) => entry.task.task)).toEqual([
          { workId: workA },
        ]);

        // The store is now exhausted: one more page, one more cursor,
        // comes back empty -- the signal a paginating caller uses to stop
        // rather than loop forever.
        const thirdPage = await store.listNativeTasks(2, workA);
        expect(thirdPage).toEqual([]);
      });
    });

    describe('all-anchor task listing', () => {
      it('includes GitHub and native anchors, newest-updated first, with a stable cursor', async () => {
        const { clock, store, orchestrator } = await fixture();
        const githubOld: TaskId = { repo: 'octo/example', issue: 1 };
        const native: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3A' };
        const githubNew: TaskId = { repo: 'octo/example', issue: 2 };

        await orchestrator.request({
          taskId: githubOld,
          requestId: 'github-old',
          pipeline: 'claude',
          work: TASK_WORK,
        });
        clock.advanceMinutes(1);
        await orchestrator.request({
          taskId: native,
          requestId: 'native',
          pipeline: 'claude',
          work: TASK_WORK,
        });
        clock.advanceMinutes(1);
        await orchestrator.request({
          taskId: githubNew,
          requestId: 'github-new',
          pipeline: 'claude',
          work: TASK_WORK,
        });

        const firstPage = await store.listTasks(2);
        expect(firstPage.map((entry) => entry.task.task)).toEqual([
          githubNew,
          native,
        ]);

        const last = firstPage[1];
        if (last === undefined) throw new Error('expected a cursor task');
        const secondPage = await store.listTasks(2, {
          updatedAt: last.task.updatedAt,
          taskKey: taskKey(last.task.task),
        });
        expect(secondPage.map((entry) => entry.task.task)).toEqual([githubOld]);
      });

      it('uses the task key to page distinct same-instant decisions without dropping either', async () => {
        const { store, orchestrator } = await fixture();
        const first: TaskId = { repo: 'octo/example', issue: 1 };
        const second: TaskId = { repo: 'octo/example', issue: 2 };
        await orchestrator.request({
          taskId: first,
          requestId: 'first',
          pipeline: 'claude',
          work: TASK_WORK,
        });
        await orchestrator.request({
          taskId: second,
          requestId: 'second',
          pipeline: 'claude',
          work: TASK_WORK,
        });

        const firstPage = await store.listTasks(1);
        const cursorTask = firstPage[0];
        if (cursorTask === undefined) throw new Error('expected a cursor task');
        const secondPage = await store.listTasks(1, {
          updatedAt: cursorTask.task.updatedAt,
          taskKey: taskKey(cursorTask.task.task),
        });
        expect(
          [...firstPage, ...secondPage].map((entry) => entry.task.task),
        ).toEqual(expect.arrayContaining([first, second]));
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
          work: TASK_WORK,
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

      it('gives exactly one of two concurrent claimants the queued run', async () => {
        const { store, orchestrator } = await fixture();
        const run = await queuedRun(orchestrator, 'q1');
        await store.enqueueRun({ runId: run.runId, now: T0 });

        // Concurrent, not sequential (final-review fix): two claims fired
        // via Promise.all, the same shape as the outbox's own "gives
        // exactly one of two concurrent claimants each entry" test above.
        // A sequential await-then-await pair only proves the SECOND call
        // sees the FIRST call's already-committed write; it says nothing
        // about whether the store's own compare-and-set actually
        // serializes two in-flight claims against each other, which is
        // exactly what a real race between two runner hosts polling at
        // once needs -- and exactly what FirestoreStore's transaction
        // retry is for (this contract also runs against a live emulator;
        // see store-contract.spec.ts).
        const [first, second] = await Promise.all([
          store.claimQueuedRun({
            pipelines: ['claude'],
            now: T0,
            claimedBy: 'runner-1',
            tokenHash: 'c'.repeat(64),
          }),
          store.claimQueuedRun({
            pipelines: ['claude'],
            now: T0,
            claimedBy: 'runner-2',
            tokenHash: 'd'.repeat(64),
          }),
        ]);
        const winners = [first, second].filter((r) => r !== undefined);
        expect(winners).toHaveLength(1);
        const winner = winners[0];
        expect(winner?.runId).toBe(run.runId);
        // Whichever claimant won, ITS OWN tokenHash landed -- proves the
        // store committed one claimant's write atomically rather than
        // merging fields from both racing calls.
        const expectedTokenHash =
          winner?.queue?.claimedBy === 'runner-1'
            ? 'c'.repeat(64)
            : 'd'.repeat(64);
        expect(winner?.queue?.tokenHash).toBe(expectedTokenHash);
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
