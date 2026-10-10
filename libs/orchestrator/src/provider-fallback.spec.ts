import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal } from './decide';
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

const NOW = '2026-10-10T02:00:00.000Z';
const PIPELINES = ['claude', 'codex', 'opencode'];
const TASK: TaskId = { repo: 'octo/example', issue: 2198 };
const WORK = { spec: { title: 'Explicit fallback contract' } };

function fixture() {
  const store = new MemoryStore();
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

describe('explicit authorized provider fallback', () => {
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
      { pipeline: 'claude', runId: '', expiresAt: '2026-10-10T03:00:00.000Z' },
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
    expect((await f.store.readTask(TASK))?.task.activeRunId).toBe(next?.runId);
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
