import { describe, expect, it } from 'vitest';

import {
  changeCredentialOperation,
  reserveCredentialOperation,
} from './credential-operation';
import {
  cancelRun,
  confirmDispatch,
  decidedRun,
  isRefusal,
  requestRun,
} from './decide';
import { lifecycleMetricSnapshot } from './lifecycle-metrics';
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

    describe('bounded lifecycle observations', () => {
      it('reads durable identities once across replay, claims and outbox settlement without changing them', async () => {
        const { store, orchestrator, clock } = await fixture();
        const first = await started(orchestrator);
        await orchestrator.request({
          taskId: TASK,
          requestId: 'req-1',
          pipeline: 'claude',
        });
        await store.enqueueRun({ runId: first.run.runId, now: T0 });
        clock.advanceMinutes(1);
        const claimed = await store.claimQueuedRun({
          pipelines: ['claude'],
          now: clock.now(),
          claimedBy: 'fixture',
          tokenHash: 'a'.repeat(64),
        });
        expect(claimed?.runId).toBe(first.run.runId);
        const leased = onlyClaim(await claimOutbox(store, clock.now()));
        await store.settleOutbox({
          entryId: leased.entryId,
          claimId: leased.claimId,
          state: 'failed',
          now: clock.now(),
          deliveryFailures: 3,
        });
        const read = { since: T0, until: clock.now(), limit: 10 };
        const before = await store.readRun(first.run.runId);
        const records = await store.readLifecycleMetricRecords(read);
        expect(records.complete).toBe(true);
        expect(records.recentRuns).toHaveLength(1);
        expect(records.liveRuns).toHaveLength(1);
        expect(records.outstandingOutbox).toMatchObject([
          { state: 'failed', deliveryFailures: 3, attempts: 1 },
        ]);
        const text = lifecycleMetricSnapshot(records, clock.now()).prometheus;
        expect(text).toContain(
          'lcars_product_admitted_window{pipeline="claude"} 1\n',
        );
        expect(text).toContain(
          'lcars_product_claims_window{pipeline="claude"} 1\n',
        );
        expect(text).toContain(
          'lcars_product_outbox_entries{kind="dispatch-run",state="failed"} 1\n',
        );
        expect(await store.readLifecycleMetricRecords(read)).toEqual(records);
        expect(await store.readRun(first.run.runId)).toEqual(before);
      });
      it('detects overflow at each bounded feed and rejects excessive caller limits', async () => {
        const { store, orchestrator } = await fixture();
        await started(orchestrator);
        await orchestrator.request({
          taskId: { repo: 'octo/example', issue: 8 },
          requestId: 'another',
          pipeline: 'codex',
          work: TASK_WORK,
        });
        const records = await store.readLifecycleMetricRecords({
          since: T0,
          until: T0,
          limit: 1,
        });
        expect(records.complete).toBe(false);
        expect(records.recentRuns).toHaveLength(1);
        expect(records.liveRuns).toHaveLength(1);
        expect(records.outstandingOutbox).toHaveLength(1);
        expect(lifecycleMetricSnapshot(records, T0).prometheus).not.toContain(
          'lcars_product_silent_loss_runs',
        );
        await expect(
          store.readLifecycleMetricRecords({
            since: T0,
            until: T0,
            limit: 1001,
          }),
        ).rejects.toThrow('Invalid lifecycle metric read bounds');
      });

      it.each(['recent', 'live', 'outbox'] as const)(
        'fails closed when only the %s feed overflows',
        async (feed) => {
          const { store, orchestrator, clock } = await fixture();
          const first = await started(orchestrator);
          if (feed !== 'outbox')
            await orchestrator.request({
              taskId: { repo: 'octo/example', issue: 8 },
              requestId: 'another',
              pipeline: 'codex',
              work: TASK_WORK,
            });
          if (feed === 'recent' || feed === 'outbox') {
            await orchestrator.report(first.run.runId, {
              ok: true,
              summary: 'park',
            });
            if (feed === 'recent')
              await orchestrator.report('octo/example#8/r1', {
                ok: true,
                summary: 'no-op',
              });
          }
          if (feed !== 'outbox')
            for (const entry of await claimOutbox(store, T0, 10))
              await store.settleOutbox({
                entryId: entry.entryId,
                claimId: entry.claimId,
                state: 'done',
                now: T0,
              });
          if (feed !== 'recent') clock.advanceMinutes(120);
          const records = await store.readLifecycleMetricRecords({
            since: clock.now(),
            until: clock.now(),
            limit: 1,
          });
          expect(records.complete).toBe(false);
          expect(records.recentRuns).toHaveLength(feed === 'recent' ? 1 : 0);
          expect(records.liveRuns).toHaveLength(feed === 'live' ? 1 : 0);
          expect(records.outstandingOutbox).toHaveLength(
            feed === 'outbox' ? 1 : 0,
          );
        },
      );
      it('keeps old live/dead-letter inventory but excludes old completions and done outbox entries', async () => {
        const { store, orchestrator, clock } = await fixture();
        const first = await started(orchestrator);
        const leased = onlyClaim(await claimOutbox(store, T0));
        await store.settleOutbox({
          entryId: leased.entryId,
          claimId: leased.claimId,
          state: 'done',
          now: T0,
        });
        clock.advanceMinutes(120);
        const records = await store.readLifecycleMetricRecords({
          since: clock.now(),
          until: clock.now(),
          limit: 10,
        });
        expect(records.complete).toBe(true);
        expect(records.recentRuns).toEqual([]);
        expect(records.liveRuns.map((run) => run.runId)).toEqual([
          first.run.runId,
        ]);
        expect(records.outstandingOutbox).toEqual([]);
      });
    });

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

      it('atomically replaces one queued generation under overlapping provider switches', async () => {
        const { store, orchestrator } = await fixture();
        const { run } = await started(orchestrator);
        await store.enqueueRun({ runId: run.runId, now: T0 });
        await orchestrator.confirmDispatch(run.runId);
        const request = (requestId: string) =>
          orchestrator.request({
            taskId: TASK,
            requestId,
            pipeline: 'opencode',
            replaceQueuedRunId: run.runId,
          });
        const outcomes = await Promise.all([
          request('switch-a'),
          request('switch-b'),
        ]);
        const accepted = outcomes.find((outcome) => !isRefusal(outcome));
        if (accepted === undefined || isRefusal(accepted))
          throw new Error('expected a replacement');
        expect(outcomes.filter(isRefusal)).toEqual([
          expect.objectContaining({ reason: 'stale-lease' }),
        ]);
        expect(await store.readRun(run.runId)).toMatchObject({
          state: 'canceled',
        });
        expect(await store.readTask(TASK)).toMatchObject({
          task: {
            activeRunId: decidedRun(accepted).runId,
            runCount: 2,
            work: TASK_WORK,
          },
        });
        expect(await store.listRuns(TASK)).toHaveLength(2);
        expect(await request(decidedRun(accepted).requestId)).toMatchObject({
          refused: true,
          reason: 'duplicate-request',
          existingRun: { runId: decidedRun(accepted).runId },
        });
      });

      it('serializes provider replacement against an executor claim', async () => {
        const { store, orchestrator } = await fixture();
        const { run } = await started(orchestrator);
        await store.enqueueRun({ runId: run.runId, now: T0 });
        await orchestrator.confirmDispatch(run.runId);
        const [claimed, replacement] = await Promise.all([
          store.claimQueuedRun({
            pipelines: ['claude'],
            now: T0,
            claimedBy: 'executor',
            tokenHash: 'a'.repeat(64),
          }),
          orchestrator.request({
            taskId: TASK,
            requestId: 'switch',
            pipeline: 'opencode',
            replaceQueuedRunId: run.runId,
          }),
        ]);
        if (claimed !== undefined) {
          expect(claimed.runId).toBe(run.runId);
          expect(replacement).toMatchObject({
            refused: true,
            reason: 'run-already-claimed',
          });
          expect(await store.listRuns(TASK)).toHaveLength(1);
          expect(await store.readRun(run.runId)).toMatchObject({
            state: 'running',
            queue: { state: 'claimed' },
          });
        } else {
          expect(replacement).not.toHaveProperty('refused');
          expect(await store.readRun(run.runId)).toMatchObject({
            state: 'canceled',
          });
          expect(await store.listRuns(TASK)).toHaveLength(2);
        }
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
      it('atomically persists loss, its successor, both effects, and terminal retry idempotency', async () => {
        const { clock, store, orchestrator } = await fixture();
        const original = await started(orchestrator, 'atomic-expiry');
        await orchestrator.confirmDispatch(original.run.runId);
        const initialDispatch = onlyClaim(
          await claimOutbox(store, clock.now(), 1),
        );
        await store.settleOutbox({
          entryId: initialDispatch.entryId,
          claimId: initialDispatch.claimId,
          state: 'done',
          now: clock.now(),
        });

        clock.advanceMinutes(121);
        const swept = await orchestrator.sweepExpired();
        const successorId = swept.retried[0]?.newRunId;
        expect(successorId).toBe(`${taskKey(TASK)}/r2`);
        expect(await store.readRun(original.run.runId)).toMatchObject({
          state: 'lost',
        });
        expect(await store.readRun(successorId as string)).toMatchObject({
          state: 'pending',
          requestId: `retry:${original.run.runId}`,
          requestSource: 'auto-retry',
        });
        expect(await store.readTask(TASK)).toMatchObject({
          task: { activeRunId: successorId, runCount: 2, consecutiveLost: 1 },
        });

        const effects = await claimOutbox(store, clock.now(), 10);
        expect(effects.map((entry) => entry.entryId).sort()).toEqual(
          [`dispatch/${successorId}`, `outcome/${original.run.runId}`].sort(),
        );

        await orchestrator.confirmDispatch(successorId as string);
        await orchestrator.report(successorId as string, { ok: true });
        const replay = await orchestrator.request({
          taskId: TASK,
          requestId: `retry:${original.run.runId}`,
          requestSource: 'auto-retry',
          pipeline: original.run.pipeline,
        });
        expect(replay).toMatchObject({
          refused: true,
          reason: 'duplicate-request',
          existingRun: expect.objectContaining({ runId: successorId }),
        });
        expect(await store.listRuns(TASK)).toHaveLength(2);
      });

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

      it('keeps an unclaimed queued run live past its request lease and starts a fresh lease when claimed', async () => {
        const { clock, store, orchestrator } = await fixture();
        const queued = await started(orchestrator, 'queued-capacity-wait');
        await store.enqueueRun({ runId: queued.run.runId, now: clock.now() });
        await orchestrator.confirmDispatch(queued.run.runId);

        clock.advanceMinutes(181);
        expect(await store.listExpiredRuns(clock.now())).toEqual([]);
        expect((await orchestrator.sweepExpired()).lost).toEqual([]);

        const claimed = await store.claimQueuedRun({
          pipelines: ['claude'],
          now: clock.now(),
          claimedBy: 'runner-after-capacity',
          tokenHash: 'a'.repeat(64),
        });
        expect(claimed?.runId).toBe(queued.run.runId);
        expect(claimed?.leaseExpiresAt).toBe(
          new Date(Date.parse(clock.now()) + 120 * 60_000).toISOString(),
        );
        expect(await store.readTask(TASK)).toMatchObject({
          task: { activeRunId: queued.run.runId, consecutiveLost: 0 },
        });
        expect(await store.listExpiredRuns(clock.now())).toEqual([]);

        await orchestrator.renew(queued.run.runId);
        clock.advanceMinutes(119);
        expect(await orchestrator.sweepExpired()).toEqual({
          lost: [],
          retried: [],
        });
        clock.advanceMinutes(2);
        const swept = await orchestrator.sweepExpired();
        expect(swept.lost.map((run) => run.runId)).toEqual([queued.run.runId]);
        expect(swept.retried).toHaveLength(1);
        expect(await store.readTask(TASK)).toMatchObject({
          task: { consecutiveLost: 1 },
        });
      });
    });

    describe('original-claim external credential reservation', () => {
      async function reservedFixture() {
        const f = await fixture();
        const outcome = await f.orchestrator.request({
          taskId: TASK,
          requestId: 'codex-operation',
          pipeline: 'codex',
          work: TASK_WORK,
        });
        if (isRefusal(outcome)) throw new Error('request refused');
        const run = decidedRun(outcome);
        await f.orchestrator.confirmDispatch(run.runId);
        await f.store.enqueueRun({ runId: run.runId, now: f.clock.now() });
        await f.store.claimQueuedRun({
          pipelines: ['codex'],
          now: f.clock.now(),
          claimedBy: 'executor',
          claimedBySubject: 'executor@example.com',
          tokenHash: 'a'.repeat(64),
        });
        const reserve = await f.store.transactRun({
          runId: run.runId,
          decide: ({ task, run }) => {
            if (task === undefined || run === undefined)
              throw new Error('missing');
            return reserveCredentialOperation({
              now: f.clock.now(),
              task: task.task,
              run,
              id: 'operation',
              kind: 'persist',
              claimFingerprint: 'a'.repeat(64),
            });
          },
        });
        expect(reserve).not.toHaveProperty('refused');
        const change = (
          change: Parameters<typeof changeCredentialOperation>[0]['change'],
          fingerprint = 'a'.repeat(64),
        ) =>
          f.store.transactRun({
            runId: run.runId,
            decide: ({ task, run }) => {
              if (task === undefined || run === undefined)
                throw new Error('missing');
              return changeCredentialOperation({
                now: f.clock.now(),
                task: task.task,
                run,
                id: 'operation',
                claimFingerprint: fingerprint,
                change,
              });
            },
          });
        return { ...f, run, change };
      }

      it('blocks release, reclaim, cancellation, expiry and exit until its external CAS is resolved', async () => {
        const f = await reservedFixture();
        const mutation = {
          kind: 'auth-write' as const,
          id: 'operation:1',
          expectedGeneration: '7',
          sha256: 'b'.repeat(64),
        };
        await f.change({ kind: 'prepare', mutation });
        const before = await f.store.readRun(f.run.runId);
        expect(
          await f.store.releaseQueuedRunClaim({
            runId: f.run.runId,
            claimedBy: 'executor',
            tokenHash: 'a'.repeat(64),
            now: f.clock.now(),
          }),
        ).toBe(false);
        expect(
          await f.store.claimQueuedRun({
            pipelines: ['codex'],
            now: f.clock.now(),
            claimedBy: 'executor',
            tokenHash: 'b'.repeat(64),
          }),
        ).toBeUndefined();
        expect(await f.orchestrator.cancel(f.run.runId)).toMatchObject({
          reason: 'credential-operation-pending',
        });
        expect(
          await f.orchestrator.executorExited(f.run.runId, {
            subject: 'executor@example.com',
            runner: 'executor',
            claimFingerprint: 'a'.repeat(64),
          }),
        ).toMatchObject({ reason: 'credential-operation-pending' });
        f.clock.advanceMinutes(121);
        expect(await f.orchestrator.sweepExpired()).toEqual({
          lost: [],
          retried: [],
        });
        expect(await f.store.readRun(f.run.runId)).toEqual(before);
        expect(await f.change({ kind: 'finish' })).toMatchObject({
          reason: 'credential-operation-pending',
        });
        expect(
          await f.change(
            { kind: 'acknowledge', mutationId: mutation.id },
            'c'.repeat(64),
          ),
        ).toMatchObject({ reason: 'not-claimant' });
        await f.change({ kind: 'acknowledge', mutationId: mutation.id });
        await f.change({ kind: 'finish' });
        expect(
          (await f.orchestrator.sweepExpired()).lost.map((r) => r.runId),
        ).toEqual([f.run.runId]);
      });

      it('never reuses an acknowledged mutation identity and refuses a stale recovery acknowledgement', async () => {
        const f = await reservedFixture();
        const first = {
          kind: 'auth-write' as const,
          id: 'operation:1',
          expectedGeneration: '7',
          sha256: 'b'.repeat(64),
        };
        await f.change({ kind: 'prepare', mutation: first });
        await f.change({ kind: 'acknowledge', mutationId: first.id });
        expect(
          await f.change({ kind: 'prepare', mutation: first }),
        ).toMatchObject({ reason: 'not-claimant' });
        const next = { ...first, id: 'operation:2' };
        await f.change({ kind: 'prepare', mutation: next });
        const before = await f.store.readRun(f.run.runId);
        expect(
          await f.change({ kind: 'acknowledge', mutationId: first.id }),
        ).toMatchObject({ reason: 'not-claimant' });
        expect(await f.store.readRun(f.run.runId)).toEqual(before);
      });

      it('invalidates an earlier lease-resolution proof when a later action prepares and acknowledges', async () => {
        const f = await reservedFixture();
        await f.orchestrator.report(
          f.run.runId,
          { ok: true, summary: 'completion before finish' },
          'a'.repeat(64),
        );
        await f.change({
          kind: 'prepare',
          mutation: {
            kind: 'lease-write',
            id: 'operation:1',
            expectedGeneration: '7',
            repository: 'octo/example',
            expiresAt: '2026-08-26T12:00:00.000Z',
          },
        });
        await f.change({ kind: 'acknowledge', mutationId: 'operation:1' });
        const before = await f.store.readRun(f.run.runId);
        expect(
          await f.change({ kind: 'finish', leaseRetiredAtSequence: 0 }),
        ).toMatchObject({ reason: 'credential-operation-pending' });
        expect(await f.store.readRun(f.run.runId)).toEqual(before);
        expect((await f.store.readTask(TASK))?.task.activeRunId).toBe(
          f.run.runId,
        );
        expect(
          await f.change({ kind: 'finish', leaseRetiredAtSequence: 1 }),
        ).toMatchObject({ run: { state: 'finished' } });
      });

      it('durably accepts only the first exact completion then settles it atomically after deadline recovery', async () => {
        const f = await reservedFixture();
        await f.change({
          kind: 'prepare',
          mutation: {
            kind: 'auth-write',
            id: 'operation:1',
            expectedGeneration: '7',
            sha256: 'b'.repeat(64),
          },
        });
        const result = {
          ok: true,
          summary: 'pull-request',
          ref: 'https://github.com/octo/example/pull/8',
          relatedRefs: [
            'https://github.com/octo/example/issues/7#issuecomment-123',
          ],
          message: 'Exact pending deliverable',
        };
        const accepted = await f.orchestrator.report(
          f.run.runId,
          result,
          'a'.repeat(64),
        );
        expect(accepted).toMatchObject({
          run: {
            state: 'running',
            credentialPendingResult: { result, requestedAt: T0 },
          },
          outbox: [],
        });
        expect(
          await f.orchestrator.report(
            f.run.runId,
            { ok: false },
            'a'.repeat(64),
          ),
        ).toMatchObject({ reason: 'credential-operation-pending' });
        f.clock.advanceMinutes(121);
        expect(await f.orchestrator.sweepExpired()).toEqual({
          lost: [],
          retried: [],
        });
        await f.change({ kind: 'acknowledge', mutationId: 'operation:1' });
        const retained = await f.store.readRun(f.run.runId);
        expect(await f.change({ kind: 'finish' })).toMatchObject({
          reason: 'credential-operation-pending',
        });
        expect(await f.store.readRun(f.run.runId)).toEqual(retained);
        expect(
          await f.change({ kind: 'finish', leaseRetiredAtSequence: 0 }),
        ).toMatchObject({ reason: 'credential-operation-pending' });
        const settled = await f.change({
          kind: 'finish',
          leaseRetiredAtSequence: 1,
        });
        expect(settled).toMatchObject({
          run: { state: 'finished', result },
          task: { consecutiveLost: 0 },
        });
        expect(
          (await f.store.readTask(TASK))?.task.activeRunId,
        ).toBeUndefined();
        expect(
          (await f.store.readRun(f.run.runId))?.credentialOperation,
        ).toBeUndefined();
        expect(
          (await f.store.readRun(f.run.runId))?.credentialPendingResult,
        ).toBeUndefined();
        expect(await f.change({ kind: 'finish' })).toMatchObject({
          reason: 'not-claimant',
        });
        const entries = await claimOutbox(f.store, f.clock.now(), 100);
        expect(entries.filter((e) => e.kind === 'report-outcome')).toHaveLength(
          1,
        );
        expect(await f.orchestrator.sweepExpired()).toEqual({
          lost: [],
          retried: [],
        });
      });
    });

    describe('first heartbeat recovery', () => {
      async function claimedFixture() {
        const f = await fixture();
        const { run } = await started(f.orchestrator);
        await f.store.enqueueRun({ runId: run.runId, now: f.clock.now() });
        await f.orchestrator.confirmDispatch(run.runId);
        const claim = await f.store.claimQueuedRun({
          pipelines: ['claude'],
          now: f.clock.now(),
          claimedBy: 'executor',
          claimedBySubject: 'executor@example.com',
          tokenHash: 'a'.repeat(64),
        });
        expect(claim?.queue?.startDeadlineAt).toBe('2026-08-15T12:15:00.000Z');
        return { ...f, run };
      }

      it('preserves first provider spawn across duplicate reports, settlement and retry', async () => {
        const f = await claimedFixture();
        const id = f.run.runId;
        const token = 'a'.repeat(64);
        await f.orchestrator.renew(id);
        expect(
          (await f.store.readRun(id))?.queue?.providerProcessStartedAt,
        ).toBeUndefined();
        f.clock.advanceMinutes(1);
        const observed = f.clock.now();
        await Promise.all([
          f.orchestrator.renew(id, token, true),
          f.orchestrator.renew(id, token, true),
        ]);
        expect(
          (await f.store.readRun(id))?.queue?.providerProcessStartedAt,
        ).toBe(observed);
        f.clock.advanceMinutes(1);
        await f.orchestrator.renew(id, token, true);
        expect(
          (await f.store.readRun(id))?.queue?.providerProcessStartedAt,
        ).toBe(observed);
        expect(
          await f.orchestrator.renew(id, 'b'.repeat(64), true),
        ).toMatchObject({ reason: 'not-claimant' });
        f.clock.advanceMinutes(121);
        expect(await f.orchestrator.renew(id, token, true)).toMatchObject({
          reason: 'stale-lease',
        });
        const sweep = await f.orchestrator.sweepExpired();
        expect(sweep.lost).toHaveLength(1);
        expect(
          (await f.store.readRun(id))?.queue?.providerProcessStartedAt,
        ).toBe(observed);
        const retry = sweep.retried[0];
        if (retry === undefined) throw new Error('expected automatic retry');
        expect(
          (await f.store.readRun(retry.newRunId))?.queue
            ?.providerProcessStartedAt,
        ).toBeUndefined();
        expect(await f.orchestrator.renew(id, token, true)).toMatchObject({
          refused: true,
        });
      });

      it('settles a launch with no callback at the startup deadline and atomically retries only twice', async () => {
        const f = await claimedFixture();
        let runId = f.run.runId;
        f.clock.advanceMinutes(14);
        expect(await f.orchestrator.sweepExpired()).toEqual({
          lost: [],
          retried: [],
        });
        f.clock.advanceMinutes(1);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const [a, b] = await Promise.all([
            f.orchestrator.sweepExpired(),
            f.orchestrator.sweepExpired(),
          ]);
          const lost = [...a.lost, ...b.lost];
          const retries = [...a.retried, ...b.retried];
          expect(lost.map((run) => run.runId)).toEqual([runId]);
          expect(lost[0]?.events.at(-1)).toMatchObject({
            by: 'expiry',
            note: 'first heartbeat deadline exceeded',
          });
          expect(await f.orchestrator.renew(runId)).toMatchObject({
            refused: true,
          });
          expect(
            await f.orchestrator.report(runId, { ok: true }),
          ).toMatchObject({ refused: true });
          if (attempt === 3) {
            expect(retries).toEqual([]);
            expect(await f.store.readTask(TASK)).toMatchObject({
              task: { consecutiveLost: 3, runCount: 3 },
            });
            expect(
              (await f.store.readTask(TASK))?.task.activeRunId,
            ).toBeUndefined();
            break;
          }
          expect(retries).toHaveLength(1);
          const next = retries[0]?.newRunId as string;
          expect(await f.store.readRun(next)).toMatchObject({
            requestId: `retry:${runId}`,
            requestSource: 'auto-retry',
          });
          await f.store.enqueueRun({ runId: next, now: f.clock.now() });
          await f.orchestrator.confirmDispatch(next);
          await f.store.claimQueuedRun({
            pipelines: ['claude'],
            now: f.clock.now(),
            claimedBy: 'executor',
            tokenHash: 'b'.repeat(64),
          });
          runId = next;
          f.clock.advanceMinutes(15);
        }
      });

      it.each([1, 14])(
        'accepts a heartbeat after %i minutes of bootstrap and then uses the renewable lease',
        async (bootstrapMinutes) => {
          const f = await claimedFixture();
          f.clock.advanceMinutes(bootstrapMinutes);
          const firstHeartbeatAt = f.clock.now();
          expect(await f.orchestrator.renew(f.run.runId)).not.toHaveProperty(
            'refused',
          );
          expect(
            (await f.store.readRun(f.run.runId))?.queue?.firstHeartbeatAt,
          ).toBe(f.clock.now());
          f.clock.advanceMinutes(100);
          expect(await f.orchestrator.sweepExpired()).toEqual({
            lost: [],
            retried: [],
          });
          await f.orchestrator.renew(f.run.runId);
          expect(
            (await f.store.readRun(f.run.runId))?.queue?.firstHeartbeatAt,
          ).toBe(firstHeartbeatAt);
          f.clock.advanceMinutes(121);
          expect((await f.orchestrator.sweepExpired()).lost).toHaveLength(1);
        },
      );

      it('fences a first heartbeat and completion at the deadline even before the sweep runs', async () => {
        const f = await claimedFixture();
        f.clock.advanceMinutes(15);
        expect(await f.orchestrator.renew(f.run.runId)).toMatchObject({
          refused: true,
          reason: 'stale-lease',
        });
        expect(
          await f.orchestrator.report(f.run.runId, { ok: true }),
        ).toMatchObject({ refused: true, reason: 'stale-lease' });
        expect((await f.orchestrator.sweepExpired()).retried).toHaveLength(1);
      });

      it('does not let concurrent expiry sweeps overwrite a claim released and reclaimed at their commit boundary', async () => {
        const { store, orchestrator, clock } = await fixture();
        const { run } = await started(orchestrator, 'startup-reclaim-race');
        await store.enqueueRun({ runId: run.runId, now: T0 });
        await orchestrator.confirmDispatch(run.runId);
        await store.claimQueuedRun({
          pipelines: ['claude'],
          now: T0,
          claimedBy: 'old-executor',
          tokenHash: 'a'.repeat(64),
        });
        clock.advanceMinutes(15);
        let interleaved = false;
        const reclaim = async () => {
          if (interleaved) return;
          interleaved = true;
          expect(
            await store.releaseQueuedRunClaim({
              runId: run.runId,
              claimedBy: 'old-executor',
              tokenHash: 'a'.repeat(64),
              now: clock.now(),
            }),
          ).toBe(true);
          expect(
            await store.claimQueuedRun({
              pipelines: ['claude'],
              now: clock.now(),
              claimedBy: 'new-executor',
              tokenHash: 'b'.repeat(64),
            }),
          ).toMatchObject({
            runId: run.runId,
            queue: { startDeadlineAt: '2026-08-15T12:30:00.000Z' },
          });
        };
        // Pause at the store's commit boundary. The legacy read/decide/apply
        // path has already made a stale decision here; an atomic run decision
        // must instead observe the fresh claim inside its transaction.
        const apply = store.apply.bind(store);
        const transactRun = store.transactRun.bind(store);
        const listExpiredRuns = store.listExpiredRuns.bind(store);
        let listed = 0;
        let releaseListings!: () => void;
        const bothListed = new Promise<void>((resolve) => {
          releaseListings = resolve;
        });
        // Both sweeps must select the old claim before either reaches its
        // committing transaction. No timing sleeps or scheduler luck needed.
        store.listExpiredRuns = async (now) => {
          const expired = await listExpiredRuns(now);
          expect(expired.map((candidate) => candidate.runId)).toEqual([
            run.runId,
          ]);
          listed += 1;
          if (listed === 2) releaseListings();
          await bothListed;
          return expired;
        };
        let reclaiming: Promise<void> | undefined;
        let freshTask: Awaited<ReturnType<OrchestratorStore['readTask']>>;
        const reclaimOnce = () =>
          (reclaiming ??= reclaim().then(async () => {
            freshTask = await store.readTask(run.task);
          }));
        store.apply = async (input) => {
          if (input.decision.run?.state === 'lost') await reclaimOnce();
          return apply(input);
        };
        store.transactRun = async (input) => {
          await reclaimOnce();
          return transactRun(input);
        };
        try {
          const sweeps = await Promise.all([
            orchestrator.sweepExpired(),
            orchestrator.sweepExpired(),
          ]);
          expect(sweeps).toEqual([
            { lost: [], retried: [] },
            { lost: [], retried: [] },
          ]);
          expect(interleaved).toBe(true);
          expect(await store.readRun(run.runId)).toMatchObject({
            state: 'running',
            queue: {
              claimedBy: 'new-executor',
              tokenHash: 'b'.repeat(64),
              startDeadlineAt: '2026-08-15T12:30:00.000Z',
            },
          });
          expect(await store.readTask(run.task)).toEqual(freshTask);
          expect((await store.listRuns(run.task)).map((r) => r.runId)).toEqual([
            run.runId,
          ]);
          expect(
            (await claimOutbox(store, clock.now())).map(
              (entry) => entry.entryId,
            ),
          ).toEqual([`dispatch/${run.runId}`]);
        } finally {
          store.apply = apply;
          store.transactRun = transactRun;
          store.listExpiredRuns = listExpiredRuns;
        }
      });

      it.each(['heartbeat', 'complete', 'exit'] as const)(
        'refuses an authenticated %s fingerprint after release/reclaim at the transaction boundary',
        async (operation) => {
          const { store, orchestrator, clock, run } = await claimedFixture();
          const original = store.transactRun.bind(store);
          let interleaved = false;
          let freshRun: Awaited<ReturnType<OrchestratorStore['readRun']>>;
          let freshTask: Awaited<ReturnType<OrchestratorStore['readTask']>>;
          store.transactRun = async (input) => {
            if (!interleaved) {
              interleaved = true;
              const released = await store.releaseQueuedRunClaim({
                runId: run.runId,
                claimedBy: 'executor',
                tokenHash: 'a'.repeat(64),
                now: clock.now(),
              });
              if (!released)
                throw new Error('original callback claim was not released');
              const claimed = await store.claimQueuedRun({
                pipelines: ['claude'],
                now: clock.now(),
                claimedBy: 'executor',
                claimedBySubject: 'executor@example.com',
                tokenHash: 'b'.repeat(64),
              });
              if (claimed?.runId !== run.runId)
                throw new Error('callback run was not reclaimed');
              freshRun = await store.readRun(run.runId);
              freshTask = await store.readTask(run.task);
            }
            return original(input);
          };
          try {
            const result =
              operation === 'heartbeat'
                ? await orchestrator.renew(run.runId, 'a'.repeat(64))
                : operation === 'complete'
                  ? await orchestrator.report(
                      run.runId,
                      { ok: true },
                      'a'.repeat(64),
                    )
                  : await orchestrator.executorExited(run.runId, {
                      subject: 'executor@example.com',
                      runner: 'executor',
                      claimFingerprint: 'a'.repeat(64),
                    });
            expect(interleaved).toBe(true);
            expect(result).toEqual({ refused: true, reason: 'not-claimant' });
            expect(await store.readRun(run.runId)).toEqual(freshRun);
            expect(await store.readTask(run.task)).toEqual(freshTask);
            expect(freshRun?.queue?.firstHeartbeatAt).toBeUndefined();
            expect(freshRun?.result).toBeUndefined();
          } finally {
            store.transactRun = original;
          }
        },
      );

      it.each([false, true])(
        'accepts matching callback fingerprints on supported claims (historical=%s)',
        async (historical) => {
          const f = await claimedFixture();
          if (historical) {
            const current = await f.store.readRun(f.run.runId);
            const task = await f.store.readTask(f.run.task);
            if (current?.queue === undefined || task === undefined)
              throw new Error('missing claim');
            const {
              startDeadlineAt: _start,
              firstHeartbeatAt: _heartbeat,
              ...queue
            } = current.queue;
            await f.store.apply({
              decision: {
                task: task.task,
                run: { ...current, queue },
                outbox: [],
              },
              expectedRevision: task.revision,
            });
          }
          f.clock.advanceMinutes(14);
          expect(
            await f.orchestrator.renew(f.run.runId, 'a'.repeat(64)),
          ).not.toHaveProperty('refused');
          f.clock.advanceMinutes(2);
          expect(
            await f.orchestrator.report(
              f.run.runId,
              { ok: true, ref: 'https://github.com/octo/example/pull/42' },
              'a'.repeat(64),
            ),
          ).not.toHaveProperty('refused');
          expect(await f.store.readRun(f.run.runId)).toMatchObject({
            state: 'finished',
            result: {
              ok: true,
              ref: 'https://github.com/octo/example/pull/42',
            },
          });
        },
      );

      it.each(['heartbeat', 'complete'] as const)(
        'rechecks the execution deadline inside an authenticated %s transaction',
        async (operation) => {
          const f = await claimedFixture();
          await f.orchestrator.renew(f.run.runId, 'a'.repeat(64));
          const before = await f.store.readRun(f.run.runId);
          const taskBefore = await f.store.readTask(f.run.task);
          const original = f.store.transactRun.bind(f.store);
          f.store.transactRun = async (input) => {
            f.clock.advanceMinutes(120);
            return original(input);
          };
          try {
            const result =
              operation === 'heartbeat'
                ? await f.orchestrator.renew(f.run.runId, 'a'.repeat(64))
                : await f.orchestrator.report(
                    f.run.runId,
                    { ok: true },
                    'a'.repeat(64),
                  );
            expect(result).toEqual({ refused: true, reason: 'stale-lease' });
            expect(await f.store.readRun(f.run.runId)).toEqual(before);
            expect(await f.store.readTask(f.run.task)).toEqual(taskBefore);
          } finally {
            f.store.transactRun = original;
          }
        },
      );

      it('drops startup bookkeeping when a lifecycle read releases the claim and grants a fresh deadline on reclaim', async () => {
        const f = await claimedFixture();
        expect(
          await f.store.releaseQueuedRunClaim({
            runId: f.run.runId,
            claimedBy: 'executor',
            tokenHash: 'a'.repeat(64),
            now: f.clock.now(),
            deferredUntil: '2026-08-15T16:00:00.000Z',
          }),
        ).toBe(true);
        f.clock.advanceMinutes(180);
        expect(await f.orchestrator.sweepExpired()).toEqual({
          lost: [],
          retried: [],
        });
        expect(
          await f.store.claimQueuedRun({
            pipelines: ['claude'],
            now: f.clock.now(),
            claimedBy: 'executor',
            tokenHash: 'b'.repeat(64),
          }),
        ).toBeUndefined();
        f.clock.advanceMinutes(60);
        const claimed = await f.store.claimQueuedRun({
          pipelines: ['claude'],
          now: f.clock.now(),
          claimedBy: 'executor',
          tokenHash: 'b'.repeat(64),
        });
        expect(claimed?.queue?.startDeadlineAt).toBe(
          '2026-08-15T16:15:00.000Z',
        );
        expect(claimed?.queue?.firstHeartbeatAt).toBeUndefined();
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
        // including a caller (the session-expiry open-item sweep) looking
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

      async function queuedRun(
        orchestrator: Orchestrator,
        requestId: string,
        pipeline = 'claude',
      ) {
        const outcome = await orchestrator.request({
          taskId: { workId: queueWorkId(requestId) },
          requestId,
          pipeline,
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

      it('does not let terminal queue remnants consume listing or claim capacity', async () => {
        const { store, orchestrator } = await fixture();
        const terminal = await queuedRun(orchestrator, 'q31');
        await store.enqueueRun({ runId: terminal.runId, now: T0 });
        await orchestrator.cancel(terminal.runId);
        const live = await queuedRun(orchestrator, 'q32');
        await store.enqueueRun({ runId: live.runId, now: T0 });

        expect((await store.listQueuedRuns(1)).map((run) => run.runId)).toEqual(
          [live.runId],
        );
        const claimed = await store.claimQueuedRun({
          pipelines: ['claude'],
          now: T0,
          claimedBy: 'executor',
          tokenHash: 'a'.repeat(64),
        });
        expect(claimed?.runId).toBe(live.runId);
        expect(await store.readRun(terminal.runId)).toMatchObject({
          state: 'canceled',
          queue: { state: 'queued' },
        });
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

      it('records the claiming principal subject durably with the claim', async () => {
        const { store, orchestrator } = await fixture();
        const run = await queuedRun(orchestrator, 'q-subject');
        await store.enqueueRun({ runId: run.runId, now: T0 });

        await store.claimQueuedRun({
          pipelines: ['claude'],
          now: T0,
          claimedBy: 'runner-1',
          claimedBySubject: 'executor@example.iam.gserviceaccount.com',
          tokenHash: 'c'.repeat(64),
        });

        expect((await store.readRun(run.runId))?.queue).toMatchObject({
          state: 'claimed',
          claimedBy: 'runner-1',
          claimedBySubject: 'executor@example.iam.gserviceaccount.com',
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

      it('releases only the exact live claim identity back to the queue', async () => {
        const { store, orchestrator } = await fixture();
        const run = await queuedRun(orchestrator, 'q33');
        await store.enqueueRun({ runId: run.runId, now: T0 });
        await orchestrator.confirmDispatch(run.runId);
        await store.claimQueuedRun({
          pipelines: ['claude'],
          now: T0,
          claimedBy: 'uncertain-runner',
          tokenHash: 'f'.repeat(64),
        });

        await expect(
          store.releaseQueuedRunClaim({
            runId: run.runId,
            claimedBy: 'wrong-runner',
            tokenHash: 'f'.repeat(64),
            now: T0,
          }),
        ).resolves.toBe(false);
        await expect(
          store.releaseQueuedRunClaim({
            runId: run.runId,
            claimedBy: 'uncertain-runner',
            tokenHash: 'f'.repeat(64),
            now: T0,
          }),
        ).resolves.toBe(true);
        expect(await store.readRun(run.runId)).toMatchObject({
          state: 'running',
          queue: { state: 'queued' },
        });
      });

      it('serializes a guarded cancellation against a queue claim', async () => {
        const { store, orchestrator } = await fixture();
        const run = await queuedRun(orchestrator, 'q4');
        await store.enqueueRun({ runId: run.runId, now: T0 });
        await orchestrator.confirmDispatch(run.runId);

        const [claim, cancellation] = await Promise.all([
          store.claimQueuedRun({
            pipelines: ['claude'],
            now: T0,
            claimedBy: 'racing-runner',
            tokenHash: 'e'.repeat(64),
          }),
          orchestrator.cancelUnclaimedBefore({
            runId: run.runId,
            notAfter: T0,
          }),
        ]);
        const stored = await store.readRun(run.runId);
        if (stored?.state === 'canceled') {
          expect(cancellation).not.toHaveProperty('refused');
          expect(claim).toBeUndefined();
        } else {
          expect(stored).toMatchObject({
            state: 'running',
            queue: { state: 'claimed', claimedBy: 'racing-runner' },
          });
          expect(cancellation).toMatchObject({
            refused: true,
            reason: 'run-already-claimed',
          });
        }
      });

      it('serializes concurrent fair claims and distributes them across waiting providers', async () => {
        const { store, orchestrator, clock } = await fixture();
        const claudeFirst = await queuedRun(orchestrator, 'q5', 'claude');
        await store.enqueueRun({ runId: claudeFirst.runId, now: clock.now() });
        clock.advanceMinutes(1);
        const claudeSecond = await queuedRun(orchestrator, 'q6', 'claude');
        await store.enqueueRun({ runId: claudeSecond.runId, now: clock.now() });
        clock.advanceMinutes(1);
        const opencode = await queuedRun(orchestrator, 'q7', 'opencode');
        await store.enqueueRun({ runId: opencode.runId, now: clock.now() });

        const claims = await Promise.all([
          store.claimQueuedRun({
            pipelines: ['claude', 'opencode'],
            now: clock.now(),
            claimedBy: 'runner-1',
            tokenHash: '6'.repeat(64),
          }),
          store.claimQueuedRun({
            pipelines: ['claude', 'opencode'],
            now: clock.now(),
            claimedBy: 'runner-2',
            tokenHash: '7'.repeat(64),
          }),
        ]);

        expect(claims.map((run) => run?.runId).sort()).toEqual(
          [claudeFirst.runId, opencode.runId].sort(),
        );
        expect((await store.readRun(claudeSecond.runId))?.queue?.state).toBe(
          'queued',
        );
      });

      it('atomically enforces exclusive provider ceilings across concurrent claims', async () => {
        for (const [pipeline, offset] of [
          ['opencode', 40],
          ['codex', 50],
        ] as const) {
          const { store, orchestrator, clock } = await fixture();
          const runs = [];
          for (const value of [offset, offset + 1]) {
            const run = await queuedRun(orchestrator, `q${value}`, pipeline);
            await store.enqueueRun({ runId: run.runId, now: clock.now() });
            runs.push(run);
            clock.advanceMinutes(1);
          }

          const claims = await Promise.all([
            store.claimQueuedRun({
              pipelines: [pipeline],
              now: clock.now(),
              claimedBy: 'runner-1',
              tokenHash: '4'.repeat(64),
            }),
            store.claimQueuedRun({
              pipelines: [pipeline],
              now: clock.now(),
              claimedBy: 'runner-2',
              tokenHash: '5'.repeat(64),
            }),
          ]);

          expect(claims.filter((run) => run !== undefined)).toHaveLength(1);
          expect(
            (await store.listQueuedRuns()).map((run) => run.runId),
          ).toEqual([runs[1]?.runId]);
        }
      });

      it.each([
        {
          summary: 'provider-limit',
          message: 'quota unavailable',
          minutes: 15,
        },
        {
          summary: 'no-deliverable',
          message: "You've hit your weekly limit · resets 12am (UTC)",
          minutes: 720,
        },
      ])(
        'holds only the quota-limited provider after $summary until its deadline',
        async ({ summary, message, minutes }) => {
          const { store, orchestrator, clock } = await fixture();
          const failed = await queuedRun(orchestrator, 'q901');
          await store.enqueueRun({ runId: failed.runId, now: clock.now() });
          const claim = {
            pipelines: ['claude'],
            now: clock.now(),
            claimedBy: 'quota-test',
            tokenHash: 'a'.repeat(64),
          };
          await store.claimQueuedRun(claim);
          await orchestrator.report(failed.runId, {
            ok: false,
            summary,
            message,
          });

          const held = await queuedRun(orchestrator, 'q902');
          const healthy = await queuedRun(orchestrator, 'q903', 'opencode');
          await store.enqueueRun({ runId: held.runId, now: clock.now() });
          await store.enqueueRun({ runId: healthy.runId, now: clock.now() });
          expect(
            (
              await store.claimQueuedRun({
                ...claim,
                pipelines: ['claude', 'opencode'],
              })
            )?.runId,
          ).toBe(healthy.runId);
          await orchestrator.report(healthy.runId, { ok: true });
          expect((await store.readRun(held.runId))?.queue?.state).toBe(
            'queued',
          );
          clock.advanceMinutes(minutes - 1);
          expect(
            await store.claimQueuedRun({ ...claim, now: clock.now() }),
          ).toBeUndefined();
          await orchestrator.sweepExpired();
          expect((await store.readTask(held.task))?.task.consecutiveLost).toBe(
            0,
          );
          clock.advanceMinutes(1);
          expect(
            (await store.claimQueuedRun({ ...claim, now: clock.now() }))?.runId,
          ).toBe(held.runId);
        },
      );

      it('reports durable queue eligibility with provider ceilings, deferral and terminal claims', async () => {
        const { store, orchestrator, clock } = await fixture();
        const first = await queuedRun(orchestrator, 'q951', 'codex');
        const second = await queuedRun(orchestrator, 'q952', 'codex');
        for (const run of [first, second])
          await store.enqueueRun({ runId: run.runId, now: clock.now() });
        const claim = {
          pipelines: ['codex'],
          now: clock.now(),
          claimedBy: 'status-test',
          tokenHash: 'a'.repeat(64),
        };
        expect((await store.readQueueAdmissionStatus(claim)).providers).toEqual(
          [
            {
              pipeline: 'codex',
              queued: 2,
              deferred: 0,
              eligible: 2,
              liveClaims: 0,
              maxLiveClaims: 1,
            },
          ],
        );
        const claimed = await store.claimQueuedRun(claim);
        expect(claimed).toBeDefined();
        if (claimed === undefined) throw new Error('missing claim');
        expect(
          (await store.readQueueAdmissionStatus(claim)).providers[0],
        ).toMatchObject({ queued: 1, liveClaims: 1, eligible: 0 });
        const deadline = new Date(
          Date.parse(clock.now()) + 60_000,
        ).toISOString();
        await store.releaseQueuedRunClaim({
          runId: claimed.runId,
          claimedBy: claim.claimedBy,
          tokenHash: claim.tokenHash,
          now: clock.now(),
          deferredUntil: deadline,
        });
        expect(
          (await store.readQueueAdmissionStatus(claim)).providers[0],
        ).toMatchObject({ queued: 2, deferred: 1, liveClaims: 0, eligible: 1 });
        await orchestrator.cancel(second.runId, 'operator canceled');
        expect(
          (await store.readQueueAdmissionStatus(claim)).providers[0],
        ).toMatchObject({ queued: 1, deferred: 1, liveClaims: 0, eligible: 0 });
        clock.advanceMinutes(1);
        const current = { ...claim, now: clock.now() };
        expect(
          (await store.readQueueAdmissionStatus(current)).providers[0],
        ).toMatchObject({ queued: 1, deferred: 0, eligible: 1 });
        expect((await store.claimQueuedRun(current))?.runId).toBe(
          claimed.runId,
        );
        await orchestrator.report(claimed.runId, { ok: true });
        expect(
          (await store.readQueueAdmissionStatus(current)).providers[0],
        ).toMatchObject({ queued: 0, liveClaims: 0, eligible: 0 });
      });

      it('reports the authoritative quota hold and removes its admission effect exactly at reset', async () => {
        const { store, orchestrator, clock } = await fixture();
        const failed = await queuedRun(orchestrator, 'q961');
        const held = await queuedRun(orchestrator, 'q962');
        await orchestrator.report(failed.runId, {
          ok: false,
          summary: 'provider-limit',
          message: 'quota unavailable',
        });
        await store.enqueueRun({ runId: held.runId, now: clock.now() });
        const input = { pipelines: ['claude', 'codex'], now: clock.now() };
        const snapshot = await store.readQueueAdmissionStatus(input);
        expect(snapshot).toMatchObject({
          observedAt: clock.now(),
          provenance: 'orchestrator',
        });
        expect(snapshot.providers[0]).toMatchObject({
          queued: 1,
          eligible: 0,
          cooldown: {
            pipeline: 'claude',
            runId: failed.runId,
            observedAt: clock.now(),
            expiresAt: '2026-08-15T12:15:00.000Z',
          },
        });
        expect(snapshot.providers[1]).toMatchObject({ queued: 0, eligible: 0 });
        clock.advanceMinutes(15);
        expect(
          (await store.readQueueAdmissionStatus({ ...input, now: clock.now() }))
            .providers[0],
        ).toMatchObject({ queued: 1, eligible: 1 });
        expect(
          (
            await store.claimQueuedRun({
              ...input,
              now: clock.now(),
              claimedBy: 'reset-test',
              tokenHash: 'b'.repeat(64),
            })
          )?.runId,
        ).toBe(held.runId);
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

      it('admits a waiting alternate ahead of a saturated provider and preserves provider FIFO', async () => {
        const { store, orchestrator, clock } = await fixture();
        for (const requestId of ['q8', 'q9']) {
          const run = await queuedRun(orchestrator, requestId, 'claude');
          await store.enqueueRun({ runId: run.runId, now: clock.now() });
          await store.claimQueuedRun({
            pipelines: ['claude'],
            now: clock.now(),
            claimedBy: `saturated-${requestId}`,
            tokenHash: '8'.repeat(64),
          });
          clock.advanceMinutes(1);
        }
        const claudeFirst = await queuedRun(orchestrator, 'q10', 'claude');
        await store.enqueueRun({
          runId: claudeFirst.runId,
          now: clock.now(),
        });
        clock.advanceMinutes(1);
        const claudeSecond = await queuedRun(orchestrator, 'q11', 'claude');
        await store.enqueueRun({
          runId: claudeSecond.runId,
          now: clock.now(),
        });
        clock.advanceMinutes(1);
        const opencodeFirst = await queuedRun(orchestrator, 'q12', 'opencode');
        await store.enqueueRun({
          runId: opencodeFirst.runId,
          now: clock.now(),
        });
        clock.advanceMinutes(1);
        const opencodeSecond = await queuedRun(orchestrator, 'q13', 'opencode');
        await store.enqueueRun({
          runId: opencodeSecond.runId,
          now: clock.now(),
        });

        const claimed: string[] = [];
        for (let index = 0; index < 2; index++) {
          const run = await store.claimQueuedRun({
            pipelines: ['opencode', 'claude'],
            now: clock.now(),
            claimedBy: `runner-${index}`,
            tokenHash: String(index).repeat(64),
          });
          if (run !== undefined) claimed.push(run.runId);
        }

        expect(claimed).toEqual([opencodeFirst.runId, claudeFirst.runId]);
        expect((await store.readRun(opencodeSecond.runId))?.queue?.state).toBe(
          'queued',
        );
        expect((await store.readRun(claudeSecond.runId))?.queue?.state).toBe(
          'queued',
        );
      });

      it('serializes OpenCode and admits its FIFO head after capacity releases', async () => {
        const { store, orchestrator, clock } = await fixture();
        const runs = [];
        for (const requestId of ['q20', 'q21', 'q22']) {
          const run = await queuedRun(orchestrator, requestId, 'opencode');
          await store.enqueueRun({ runId: run.runId, now: clock.now() });
          runs.push(run);
          clock.advanceMinutes(1);
        }
        const claim = (runner: string, tokenDigit: string) =>
          store.claimQueuedRun({
            pipelines: ['opencode'],
            now: clock.now(),
            claimedBy: runner,
            tokenHash: tokenDigit.repeat(64),
          });

        expect((await claim('runner-1', 'a'))?.runId).toBe(runs[0]?.runId);
        expect(await claim('runner-2', 'b')).toBeUndefined();

        const first = runs[0];
        if (first === undefined) throw new Error('expected first run');
        await orchestrator.report(first.runId, { ok: true });
        expect((await claim('runner-2', 'b'))?.runId).toBe(runs[1]?.runId);
      });

      it('does not admit a second live Codex claim against its exclusive credential lease', async () => {
        const { store, orchestrator, clock } = await fixture();
        for (const requestId of ['q30', 'q31']) {
          const run = await queuedRun(orchestrator, requestId, 'codex');
          await store.enqueueRun({ runId: run.runId, now: clock.now() });
          clock.advanceMinutes(1);
        }
        const claim = (runner: string, tokenDigit: string) =>
          store.claimQueuedRun({
            pipelines: ['codex'],
            now: clock.now(),
            claimedBy: runner,
            tokenHash: tokenDigit.repeat(64),
          });

        expect(await claim('runner-1', 'a')).toBeDefined();
        expect(await claim('runner-2', 'b')).toBeUndefined();
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
 * parallel to {@link runOrchestratorStoreContract}. Configuration changes,
 * occurrence admission and settlement share one atomic schedule owner;
 * writeSchedule remains a low-level fixture/import writer.
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

    it('admits only one configuration update at the same revision', async () => {
      const store = await makeStore();
      const initial = schedule({ revision: 1 });
      await store.writeSchedule(initial);
      const results = await Promise.all(
        ['first', 'second'].map((title) =>
          store.mutateSchedule(initial.scheduleId, (current) => {
            if (current?.revision !== 1) return undefined;
            return { ...current, revision: 2, spec: { title } };
          }),
        ),
      );
      expect(results.filter((result) => result !== undefined)).toHaveLength(1);
      expect((await store.readSchedule(initial.scheduleId))?.revision).toBe(2);
    });

    it('keeps an admitted pending occurrence after deletion, without listing the schedule', async () => {
      const store = await makeStore();
      const initial = schedule({ revision: 1 });
      await store.writeSchedule(initial);
      const pendingTick = {
        slotAt: SCHEDULE_T0,
        itemId: '01J5Z3K9QX8F0N2B4V6C8D1E3H',
        revision: 1,
        spec: initial.spec,
        createdBy: initial.createdBy,
      };
      await store.mutateSchedule(initial.scheduleId, (current) => {
        if (current === undefined) throw new Error('Missing schedule fixture');
        return { ...current, pendingTick };
      });
      await store.mutateSchedule(initial.scheduleId, (current) => {
        if (current === undefined) throw new Error('Missing schedule fixture');
        return {
          ...current,
          revision: 2,
          enabled: false,
          deletedAt: SCHEDULE_T0,
        };
      });
      expect(await store.listSchedules()).toEqual([]);
      expect(await store.listEnabledSchedules()).toEqual([]);
      expect((await store.listTickSchedules())[0]?.pendingTick).toEqual(
        pendingTick,
      );
      await store.mutateSchedule(initial.scheduleId, (current) => {
        if (current === undefined) throw new Error('Missing schedule fixture');
        const { pendingTick: _pending, ...rest } = current;
        return rest;
      });
      expect(await store.listTickSchedules()).toEqual([]);
      expect((await store.readSchedule(initial.scheduleId))?.deletedAt).toBe(
        SCHEDULE_T0,
      );
    });

    it('fills a visible page after newer deletion tombstones', async () => {
      const store = await makeStore();
      const ids = [
        '01J5Z3K9QX8F0N2B4V6C8D1E3A',
        '01J5Z3K9QX8F0N2B4V6C8D1E3B',
        '01J5Z3K9QX8F0N2B4V6C8D1E3C',
      ];
      for (const scheduleId of ids)
        await store.writeSchedule(
          schedule({
            scheduleId,
            ...(scheduleId === ids[2]
              ? { deletedAt: SCHEDULE_T0, enabled: false }
              : {}),
          }),
        );
      expect((await store.listSchedules(2)).map((s) => s.scheduleId)).toEqual([
        ids[1],
        ids[0],
      ]);
    });

    it('round-trips a written schedule', async () => {
      const store = await makeStore();
      await store.writeSchedule(schedule());
      expect(await store.readSchedule('01J5Z3K9QX8F0N2B4V6C8D1E3G')).toEqual(
        schedule(),
      );
    });

    it('round-trips successful and closed occurrence metadata', async () => {
      const store = await makeStore();
      const withOptionals = schedule({
        lastSlotAt: SCHEDULE_T0,
        lastItemId: '01J5Z3K9QX8F0N2B4V6C8D1E3H',
        disabledReason: 'grant-revoked',
        lastClosedSlotAt: SCHEDULE_T0,
        revision: 2,
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
