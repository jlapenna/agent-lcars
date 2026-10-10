import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal } from './decide';
import { FirestoreStore } from './firestore-store';
import { MemoryStore } from './memory-store';
import {
  providerFallbackSchema,
  type Run,
  RUN_ID_MAX_LENGTH,
  runSchema,
  type TaskId,
} from './model';
import { Orchestrator } from './orchestrator';
import { rerouteQueuedRun } from './provider-fallback';
import type { OrchestratorStore } from './store';

const NOW = '2026-10-10T02:00:00.000Z';
const PIPELINES = ['claude', 'codex', 'opencode'];
const TASK: TaskId = { repo: 'octo/example', issue: 2198 };
const WORK = { spec: { title: 'Explicit fallback contract' } };

function runFallbackContract(
  name: string,
  createStore: () => OrchestratorStore,
) {
  function fixture() {
    const store = createStore();
    let grants = [...PIPELINES];
    let currentTime = NOW;
    const orchestrator = new Orchestrator(
      store,
      { now: () => currentTime },
      {
        pipelines: PIPELINES,
        allowedPipelines: (_task, run) =>
          run.providerFallback?.principal === 'user:operator' ? grants : [],
      },
    );
    return {
      store,
      orchestrator,
      advanceMinutes(minutes: number) {
        currentTime = new Date(
          Date.parse(currentTime) + minutes * 60_000,
        ).toISOString();
      },
      revoke(pipelines: string[]) {
        grants = pipelines;
      },
      async request(
        input: {
          task?: TaskId;
          pipeline?: string;
          alternatives?: string[];
          params?: Record<string, string>;
        } = {},
      ) {
        const task = input.task ?? TASK;
        const result = await orchestrator.request({
          taskId: task,
          requestId: 'caller-request',
          pipeline: input.pipeline ?? 'claude',
          work: WORK,
          ...(input.params === undefined ? {} : { params: input.params }),
          ...(input.alternatives === undefined
            ? {}
            : {
                providerFallback: {
                  principal: 'user:operator',
                  allowedPipelines: input.alternatives,
                },
              }),
        });
        if (isRefusal(result)) throw new Error(result.reason);
        return decidedRun(result);
      },
      async limit(run: Run) {
        return orchestrator.report(run.runId, {
          ok: false,
          summary: 'provider-limit',
        });
      },
    };
  }

  describe(`explicit authorized provider fallback: ${name}`, () => {
    it.each([
      { alternatives: undefined, summary: 'provider-limit' },
      { alternatives: ['codex'], summary: 'ordinary-failure' },
      { alternatives: undefined, summary: 'ordinary-failure' },
    ])(
      'does not load global queue eligibility for non-fallback failure $summary/$alternatives',
      async ({ alternatives, summary }) => {
        const f = fixture();
        const original = await f.request({ alternatives });
        let snapshots = 0;
        const transact = f.store.transactRun.bind(f.store);
        f.store.transactRun = async (input) =>
          transact({
            ...input,
            decide: (state) => {
              if (state.queueEligibility !== undefined) snapshots++;
              return input.decide(state);
            },
          });
        await f.orchestrator.report(original.runId, { ok: false, summary });
        expect(snapshots).toBe(0);
        expect((await f.store.readRun(original.runId))?.state).toBe('finished');
      },
    );
    it.each(['warm', 'cold'] as const)(
      'advances bounded %s batches past permanently unavailable oldest alternatives',
      async (mode) => {
        const f = fixture();
        const limited = await f.request({
          task: { repo: 'octo/example', issue: 1 },
        });
        await f.limit(limited);
        for (const issue of [2, 3]) {
          const older = await f.request({
            task: { repo: 'octo/example', issue },
            alternatives: ['codex'],
          });
          await f.store.enqueueRun({ runId: older.runId, now: NOW });
        }
        f.advanceMinutes(1);
        const later = await f.request({
          task: { repo: 'octo/example', issue: 4 },
          alternatives: ['opencode'],
        });
        await f.store.enqueueRun({ runId: later.runId, now: NOW });
        f.revoke(['claude', 'opencode']);
        const rerouted = [];
        let transactions = 0;
        const transact = f.store.transactRun.bind(f.store);
        f.store.transactRun = async (input) => {
          transactions++;
          return transact(input);
        };
        for (let tick = 0; tick < 3; tick++) {
          const executor =
            mode === 'warm'
              ? f.orchestrator
              : new Orchestrator(
                  f.store,
                  {
                    now: () =>
                      new Date(
                        Date.parse(NOW) + (tick + 1) * 60_000,
                      ).toISOString(),
                  },
                  {
                    pipelines: PIPELINES,
                    allowedPipelines: () => ['claude', 'opencode'],
                  },
                );
          rerouted.push(...(await executor.rerouteQueued(PIPELINES, 1)));
          expect(transactions).toBe(tick + 1);
        }
        expect(rerouted).toContainEqual({
          fromRunId: later.runId,
          newRunId: later.runId.replace('/r1', '/r2'),
        });
      },
    );

    it('serializes concurrent duplicate limit reports into one successor', async () => {
      const f = fixture();
      const original = await f.request({ alternatives: ['codex'] });
      await Promise.all([f.limit(original), f.limit(original)]);
      expect(await f.store.listRuns(TASK)).toHaveLength(2);
      expect(await f.store.readActiveRun(TASK)).toMatchObject({
        pipeline: 'codex',
        providerFallback: { fromRunId: original.runId },
      });
    });
    it('bounds provenance and refuses ambiguous policy histories', () => {
      const policy = {
        principal: 'user:operator',
        allowedPipelines: ['codex'],
        attemptedPipelines: ['claude'],
        originalRunId: 'r'.repeat(RUN_ID_MAX_LENGTH),
      };
      expect(providerFallbackSchema.safeParse(policy).success).toBe(true);
      for (const invalid of [
        { ...policy, allowedPipelines: ['codex', 'codex'] },
        { ...policy, attemptedPipelines: ['claude', 'claude'] },
        { ...policy, fromRunId: 'previous/r1' },
        { ...policy, originalRunId: 'r'.repeat(RUN_ID_MAX_LENGTH + 1) },
      ])
        expect(providerFallbackSchema.safeParse(invalid).success).toBe(false);
    });
    it('does not mint an attempt from malformed or mismatched cooldown provenance', async () => {
      const f = fixture();
      const queued = await f.request({ alternatives: ['codex'] });
      await f.store.enqueueRun({ runId: queued.runId, now: NOW });
      const task = (await f.store.readTask(TASK))!.task;
      const run = (await f.store.readRun(queued.runId))!;
      for (const cooldown of [
        {
          pipeline: 'codex',
          runId: 'other/r1',
          expiresAt: '2026-10-10T03:00:00.000Z',
        },
        {
          pipeline: 'claude',
          runId: '',
          expiresAt: '2026-10-10T03:00:00.000Z',
        },
        {
          pipeline: 'claude',
          runId: 'r'.repeat(RUN_ID_MAX_LENGTH + 1),
          expiresAt: '2026-10-10T03:00:00.000Z',
        },
      ])
        expect(
          rerouteQueuedRun({
            now: NOW,
            task,
            run,
            cooldown,
            authorizedPipelines: PIPELINES,
            availablePipelines: PIPELINES,
          }),
        ).toEqual({ refused: true, reason: 'stale-lease' });
      expect(await f.store.listRuns(TASK)).toHaveLength(1);
    });
    it('settles and preserves cooldown without opt-in', async () => {
      const f = fixture();
      const run = await f.request();
      expect(await f.limit(run)).toMatchObject({ run: { state: 'finished' } });
      expect(await f.store.listRuns(TASK)).toHaveLength(1);
      const queued = await f.request({
        task: { repo: 'octo/example', issue: 1 },
      });
      await f.store.enqueueRun({ runId: queued.runId, now: NOW });
      expect(
        await f.store.claimQueuedRun({
          pipelines: ['claude'],
          now: NOW,
          claimedBy: 'executor',
          tokenHash: 'a'.repeat(64),
        }),
      ).toBeUndefined();
    });
    it('atomically links a fresh deterministic attempt and strips resume artifacts', async () => {
      const f = fixture();
      const run = await f.request({
        alternatives: ['codex', 'opencode'],
        params: {
          mode: 'reply',
          reply: 'Finish this exact request',
          resumeSessionId: 'old-provider-session',
          resumeTranscriptGcsUri: 'gs://example/old-provider',
        },
      });
      const outcome = await f.limit(run);
      expect(outcome).toMatchObject({
        run: {
          runId: run.runId,
          state: 'finished',
          result: { summary: 'provider-limit' },
        },
        additionalRuns: [
          {
            pipeline: 'codex',
            requestSource: 'provider-fallback',
            requestId: `fallback:${run.runId}`,
            params: { mode: 'reply', reply: 'Finish this exact request' },
            providerFallback: {
              originalRunId: run.runId,
              fromRunId: run.runId,
              attemptedPipelines: ['claude', 'codex'],
              trigger: {
                reason: 'provider-limit',
                failureRunId: run.runId,
                limitedPipeline: 'claude',
              },
            },
          },
        ],
        outbox: [{ kind: 'report-outcome' }, { kind: 'dispatch-run' }],
      });
      const runs = await f.store.listRuns(TASK);
      const next = runs.find((candidate) => candidate.runId !== run.runId);
      expect(next?.params).not.toHaveProperty('resumeSessionId');
      expect(next?.params).not.toHaveProperty('resumeTranscriptGcsUri');
      expect(runSchema.parse(next)).toEqual(next);
      expect((await f.store.readTask(TASK))?.task.activeRunId).toBe(
        next?.runId,
      );
      expect(await f.limit(run)).toMatchObject({
        refused: true,
        reason: 'run-not-live',
      });
      expect(await f.store.listRuns(TASK)).toHaveLength(2);
    });
    it('rechecks current authority rather than trusting its admission-time list', async () => {
      const f = fixture();
      const run = await f.request({ alternatives: ['codex', 'opencode'] });
      f.revoke(['claude']);
      await f.limit(run);
      expect(await f.store.listRuns(TASK)).toHaveLength(1);
    });
    it('selects the first available authorized alternative and preserves all cooldowns', async () => {
      const f = fixture();
      await f.limit(
        await f.request({
          task: { repo: 'octo/example', issue: 1 },
          pipeline: 'codex',
        }),
      );
      const run = await f.request({ alternatives: ['codex', 'opencode'] });
      await f.limit(run);
      expect(await f.store.readActiveRun(TASK)).toMatchObject({
        pipeline: 'opencode',
      });
      expect(
        await f.store.claimQueuedRun({
          pipelines: ['claude', 'codex'],
          now: NOW,
          claimedBy: 'executor',
          tokenHash: 'a'.repeat(64),
        }),
      ).toBeUndefined();
    });
    it('skips an occupied serialized provider without weakening its claim ceiling', async () => {
      const f = fixture();
      const busy = await f.request({
        task: { repo: 'octo/example', issue: 1 },
        pipeline: 'codex',
      });
      await f.store.enqueueRun({ runId: busy.runId, now: NOW });
      expect(
        await f.store.claimQueuedRun({
          pipelines: ['codex'],
          now: NOW,
          claimedBy: 'executor',
          tokenHash: 'a'.repeat(64),
        }),
      ).toMatchObject({ runId: busy.runId });
      const run = await f.request({ alternatives: ['codex', 'opencode'] });
      await f.limit(run);
      expect(await f.store.readActiveRun(TASK)).toMatchObject({
        pipeline: 'opencode',
      });
    });
    it('retains one fresh authorized intent when every alternative is occupied, then claims after capacity frees', async () => {
      const f = fixture();
      const busy = [];
      for (const [index, pipeline] of ['codex', 'opencode'].entries()) {
        const run = await f.request({
          task: { repo: 'octo/example', issue: index + 1 },
          pipeline,
        });
        await f.store.enqueueRun({ runId: run.runId, now: NOW });
        expect(
          await f.store.claimQueuedRun({
            pipelines: [pipeline],
            now: NOW,
            claimedBy: 'busy-executor',
            tokenHash: 'a'.repeat(64),
          }),
        ).toMatchObject({ runId: run.runId });
        busy.push(run);
      }
      const original = await f.request({
        alternatives: ['codex', 'opencode'],
        params: {
          mode: 'reply',
          reply: 'Preserve this intent',
          resumeSessionId: 'old-session',
          resumeTranscriptGcsUri: 'gs://example/old',
        },
      });
      await Promise.all([f.limit(original), f.limit(original)]);
      const waiting = await f.store.readActiveRun(TASK);
      expect(waiting).toMatchObject({
        runId: original.runId.replace('/r1', '/r2'),
        pipeline: 'codex',
        requestId: `fallback:${original.runId}`,
        requestSource: 'provider-fallback',
        providerFallback: {
          originalRunId: original.runId,
          fromRunId: original.runId,
          attemptedPipelines: ['claude', 'codex'],
          trigger: {
            reason: 'provider-limit',
            failureRunId: original.runId,
            limitedPipeline: 'claude',
          },
        },
        params: { mode: 'reply', reply: 'Preserve this intent' },
      });
      if (waiting === undefined)
        throw new Error('missing waiting fallback intent');
      expect(waiting.params).not.toHaveProperty('resumeSessionId');
      expect(waiting.params).not.toHaveProperty('resumeTranscriptGcsUri');
      expect(runSchema.parse(waiting)).toEqual(waiting);
      await f.store.enqueueRun({ runId: waiting.runId, now: NOW });
      expect(
        await f.store.claimQueuedRun({
          pipelines: ['codex', 'opencode'],
          now: NOW,
          claimedBy: 'successor-executor',
          tokenHash: 'b'.repeat(64),
        }),
      ).toBeUndefined();
      expect(await f.orchestrator.rerouteQueued(PIPELINES)).toEqual([]);
      expect(
        await f.orchestrator.request({
          taskId: TASK,
          requestId: 'other-intent',
          pipeline: 'claude',
          work: WORK,
        }),
      ).toMatchObject({ refused: true, reason: 'task-busy' });
      expect(await f.store.listRuns(TASK)).toHaveLength(2);
      await f.orchestrator.report(busy[0].runId, {
        ok: true,
        summary: 'released capacity',
      });
      expect(
        await f.store.claimQueuedRun({
          pipelines: ['codex'],
          now: NOW,
          claimedBy: 'successor-executor',
          tokenHash: 'b'.repeat(64),
        }),
      ).toMatchObject({
        runId: waiting.runId,
        pipeline: 'codex',
        queue: { state: 'claimed' },
      });
      expect(await f.store.listRuns(TASK)).toHaveLength(2);
      const entries = await f.store.claimPendingOutbox({
        limit: 30,
        now: NOW,
        leaseExpiresAt: '2026-10-10T02:05:00.000Z',
      });
      expect(
        entries.filter(
          (entry) =>
            entry.kind === 'dispatch-run' && entry.runId === waiting.runId,
        ),
      ).toHaveLength(1);
      expect(
        entries.filter(
          (entry) =>
            entry.kind === 'report-outcome' && entry.runId === original.runId,
        ),
      ).toHaveLength(1);
    });

    it('retains a fresh intent across all alternative cooldowns and executes it when its cooldown expires', async () => {
      const f = fixture();
      for (const [index, pipeline] of ['codex', 'opencode'].entries())
        await f.limit(
          await f.request({
            task: { repo: 'octo/example', issue: index + 1 },
            pipeline,
          }),
        );
      const original = await f.request({ alternatives: ['codex', 'opencode'] });
      await f.limit(original);
      const waiting = await f.store.readActiveRun(TASK);
      expect(waiting).toMatchObject({
        pipeline: 'codex',
        providerFallback: { fromRunId: original.runId },
      });
      if (waiting === undefined)
        throw new Error('missing cooldown-waiting intent');
      await f.store.enqueueRun({ runId: waiting.runId, now: NOW });
      expect(await f.orchestrator.rerouteQueued(PIPELINES)).toEqual([]);
      expect(
        await f.store.claimQueuedRun({
          pipelines: ['codex'],
          now: NOW,
          claimedBy: 'executor',
          tokenHash: 'b'.repeat(64),
        }),
      ).toBeUndefined();
      f.advanceMinutes(16);
      expect(
        await f.store.claimQueuedRun({
          pipelines: ['codex'],
          now: '2026-10-10T02:16:00.000Z',
          claimedBy: 'executor',
          tokenHash: 'b'.repeat(64),
        }),
      ).toMatchObject({ runId: waiting.runId });
      await f.limit(waiting);
      const final = await f.store.readActiveRun(TASK);
      expect(final).toMatchObject({
        pipeline: 'opencode',
        providerFallback: {
          originalRunId: original.runId,
          fromRunId: waiting.runId,
          attemptedPipelines: ['claude', 'codex', 'opencode'],
        },
      });
      if (final === undefined) throw new Error('missing last allowed attempt');
      f.advanceMinutes(16);
      await f.limit(final);
      expect(await f.store.readActiveRun(TASK)).toBeUndefined();
      expect(await f.store.listRuns(TASK)).toHaveLength(3);
    });

    it('keeps fallback and admission consistent across quota holds, occupied alternatives and reset', async () => {
      const f = fixture();
      const busy = await f.request({
        task: { repo: 'octo/example', issue: 1 },
        pipeline: 'codex',
      });
      await f.store.enqueueRun({ runId: busy.runId, now: NOW });
      await f.store.claimQueuedRun({
        pipelines: ['codex'],
        now: NOW,
        claimedBy: 'busy-executor',
        tokenHash: 'a'.repeat(64),
      });
      const waiting = await f.request({
        task: { repo: 'octo/example', issue: 2 },
        pipeline: 'codex',
      });
      await f.store.enqueueRun({ runId: waiting.runId, now: NOW });
      const original = await f.request({
        alternatives: ['codex', 'opencode'],
      });
      await f.limit(original);
      const next = await f.store.readActiveRun(TASK);
      expect(next?.pipeline).toBe('opencode');
      if (next === undefined) throw new Error('missing fallback successor');
      await f.store.enqueueRun({ runId: next.runId, now: NOW });
      const held = await f.request({
        task: { repo: 'octo/example', issue: 3 },
      });
      await f.store.enqueueRun({ runId: held.runId, now: NOW });
      const snapshot = await f.store.readQueueAdmissionStatus({
        pipelines: PIPELINES,
        now: NOW,
      });
      expect(snapshot.providers).toMatchObject([
        {
          pipeline: 'claude',
          queued: 1,
          eligible: 0,
          cooldown: { runId: original.runId },
        },
        { pipeline: 'codex', queued: 1, eligible: 0, liveClaims: 1 },
        { pipeline: 'opencode', queued: 1, eligible: 1, liveClaims: 0 },
      ]);
      expect(
        await f.store.claimQueuedRun({
          pipelines: PIPELINES,
          now: NOW,
          claimedBy: 'fallback-executor',
          tokenHash: 'b'.repeat(64),
        }),
      ).toMatchObject({ runId: next.runId, pipeline: 'opencode' });
      f.advanceMinutes(15);
      expect(
        (
          await f.store.readQueueAdmissionStatus({
            pipelines: PIPELINES,
            now: '2026-10-10T02:15:00.000Z',
          })
        ).providers,
      ).toMatchObject([
        { pipeline: 'claude', queued: 1, eligible: 1 },
        { pipeline: 'codex', queued: 1, eligible: 0, liveClaims: 1 },
        { pipeline: 'opencode', queued: 0, eligible: 0, liveClaims: 1 },
      ]);
    });
    it('never cycles back to an attempted provider, even after that provider recovers', async () => {
      const f = fixture();
      const first = await f.request({ alternatives: ['codex', 'opencode'] });
      await f.limit(first);
      const second = await f.store.readActiveRun(TASK);
      expect(second?.pipeline).toBe('codex');
      await f.limit(second!);
      const third = await f.store.readActiveRun(TASK);
      expect(third?.pipeline).toBe('opencode');
      f.advanceMinutes(16);
      await f.limit(third!);
      expect(await f.store.listRuns(TASK)).toHaveLength(3);
      expect(await f.store.readActiveRun(TASK)).toBeUndefined();
    });
    it.each([
      { ok: false, summary: 'verification-failed' },
      { ok: true, summary: 'done' },
    ])('does not fallback for an ordinary report: $summary', async (result) => {
      const f = fixture();
      const run = await f.request({ alternatives: ['codex'] });
      await f.orchestrator.report(run.runId, result);
      expect(await f.store.listRuns(TASK)).toHaveLength(1);
    });
    it('reroutes an exact queued intent with the external cooldown failure linked', async () => {
      const f = fixture();
      const limited = await f.request({
        task: { repo: 'octo/example', issue: 1 },
      });
      await f.limit(limited);
      const queued = await f.request({ alternatives: ['codex', 'opencode'] });
      await f.store.enqueueRun({ runId: queued.runId, now: NOW });
      const rerouted = await f.orchestrator.rerouteQueued(PIPELINES);
      expect(rerouted).toHaveLength(1);
      expect(await f.store.readRun(queued.runId)).toMatchObject({
        state: 'canceled',
        events: [
          expect.any(Object),
          {
            at: NOW,
            to: 'canceled',
            by: 'provider-fallback',
            note: expect.any(String),
          },
        ],
      });
      expect(await f.store.readActiveRun(TASK)).toMatchObject({
        pipeline: 'codex',
        providerFallback: {
          originalRunId: queued.runId,
          fromRunId: queued.runId,
          trigger: {
            reason: 'provider-cooldown',
            failureRunId: limited.runId,
            limitedPipeline: 'claude',
          },
        },
      });
      expect(await f.orchestrator.rerouteQueued(PIPELINES)).toEqual([]);
      expect(await f.store.listRuns(TASK)).toHaveLength(2);
    });
    it('leaves queued work untouched when every alternative is cooling down', async () => {
      const f = fixture();
      for (const [index, pipeline] of PIPELINES.entries())
        await f.limit(
          await f.request({
            task: { repo: 'octo/example', issue: index + 1 },
            pipeline,
          }),
        );
      const queued = await f.request({ alternatives: ['codex', 'opencode'] });
      await f.store.enqueueRun({ runId: queued.runId, now: NOW });
      expect(await f.orchestrator.rerouteQueued(PIPELINES)).toEqual([]);
      expect(await f.store.readActiveRun(TASK)).toMatchObject({
        runId: queued.runId,
        queue: { state: 'queued' },
      });
      expect(await f.store.listRuns(TASK)).toHaveLength(1);
    });
    it('does not let older healthy provider requests starve the bounded reroute pass', async () => {
      const f = fixture();
      for (let issue = 1; issue <= 31; issue++) {
        const healthy = await f.request({
          task: { repo: 'octo/example', issue },
          pipeline: 'codex',
          alternatives: ['opencode'],
        });
        await f.store.enqueueRun({ runId: healthy.runId, now: NOW });
      }
      await f.limit(
        await f.request({ task: { repo: 'octo/example', issue: 99 } }),
      );
      const blocked = await f.request({ alternatives: ['opencode'] });
      await f.store.enqueueRun({ runId: blocked.runId, now: NOW });
      expect(await f.orchestrator.rerouteQueued(PIPELINES, 1)).toHaveLength(1);
      expect(await f.store.readActiveRun(TASK)).toMatchObject({
        pipeline: 'opencode',
      });
    });
    it('cannot reroute a claimed conversation or escape the executor grant', async () => {
      const f = fixture();
      const run = await f.request({ alternatives: ['codex'] });
      await f.store.enqueueRun({ runId: run.runId, now: NOW });
      await f.store.claimQueuedRun({
        pipelines: ['claude'],
        now: NOW,
        claimedBy: 'executor',
        tokenHash: 'a'.repeat(64),
      });
      await f.limit(
        await f.request({ task: { repo: 'octo/example', issue: 1 } }),
      );
      expect(await f.orchestrator.rerouteQueued(PIPELINES)).toEqual([]);
      expect(await f.store.readActiveRun(TASK)).toMatchObject({
        runId: run.runId,
        queue: { state: 'claimed' },
      });
      const queued = await f.request({
        task: { repo: 'octo/example', issue: 2 },
        alternatives: ['codex'],
      });
      await f.store.enqueueRun({ runId: queued.runId, now: NOW });
      expect(await f.orchestrator.rerouteQueued(['claude'])).toEqual([]);
      expect(await f.store.readRun(queued.runId)).toMatchObject({
        queue: { state: 'queued' },
      });
    });
  });
}
runFallbackContract('MemoryStore', () => new MemoryStore());
const fallbackEmulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
if (
  process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' &&
  fallbackEmulatorHost === undefined
)
  throw new Error('Provider fallback Firestore contract requires the emulator');
if (fallbackEmulatorHost !== undefined) {
  let collectionCounter = 0;
  runFallbackContract(
    'FirestoreStore (emulator)',
    () =>
      new FirestoreStore({
        projectId: 'demo-orchestrator',
        databaseId: '(default)',
        emulatorHost: fallbackEmulatorHost,
        collectionPrefix: `fallback2198-${Date.now()}-${++collectionCounter}-`,
      }),
  );
}
