import { describe, expect, it } from 'vitest';

import { cancelRun, decidedRun, isRefusal } from './decide';
import { advanceDelivery } from './delivery';
import {
  type LifecycleMetricRecords,
  lifecycleMetricSnapshot,
} from './lifecycle-metrics';
import { type DeliveryBinding, type OutboxEntry, type Run } from './model';

const NOW = '2026-10-10T12:00:00.000Z';
const createdAt = '2026-10-10T11:40:00.000Z';
function run(over: Partial<Run> = {}): Run {
  return {
    runId: 'private/repo#42/r1',
    task: { repo: 'private/repo', issue: 42 },
    state: 'running',
    pipeline: 'claude',
    requestId: 'private-request',
    requestSource: 'caller',
    leaseExpiresAt: '2026-10-10T13:40:00.000Z',
    queue: { state: 'queued' },
    events: [
      { at: createdAt, to: 'pending', by: 'request' },
      { at: '2026-10-10T11:40:30.000Z', to: 'running', by: 'dispatch' },
    ],
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}
function snapshot(runs: Run[], over: Partial<LifecycleMetricRecords> = {}) {
  return lifecycleMetricSnapshot(
    {
      recentRuns: runs,
      liveRuns: runs.filter(
        (r) => r.state === 'pending' || r.state === 'running',
      ),
      outstandingOutbox: [],
      complete: true,
      ...over,
    },
    NOW,
  ).prometheus;
}

const finishedAt = '2026-10-10T11:45:00.000Z';
const deliveryAt = '2026-10-10T11:50:00.000Z';
function delivered(
  over: Partial<DeliveryBinding> = {},
): Run & { delivery: DeliveryBinding } {
  const original = run({
    state: 'finished',
    result: { ok: true, summary: 'pull-request' },
    events: [{ at: finishedAt, to: 'finished', by: 'report' }],
    updatedAt: deliveryAt,
  });
  return {
    ...original,
    delivery: {
      runId: original.runId,
      repo: 'private/repo',
      number: 99,
      baseRef: 'main',
      head: 'a'.repeat(40),
      mergeCommit: 'b'.repeat(40),
      state: 'complete',
      runtimeGate: 'none',
      observedAt: deliveryAt,
      ...over,
    },
  };
}

function deliveryMeasurements(original: Run) {
  const text = snapshot([original]);
  return {
    completed: text.match(
      /lcars_product_completed_pr_delivery_window\{pipeline="claude"\} (\d+)\n/u,
    )?.[1],
    unknown: text.match(
      /lcars_product_measurement_unknown_window\{pipeline="claude",measurement="useful_outcome"\} (\d+)\n/u,
    )?.[1],
  };
}

describe('durable lifecycle metric accounting', () => {
  it('counts trusted redispatch generations separately while deduplicating their task', () => {
    const redispatched = run({
      events: [
        {
          at: createdAt,
          to: 'pending',
          by: 'request',
          intervention: {
            kind: 'work-api-redispatch',
            principal: 'svc:verified',
          },
        },
      ],
    });
    const retry = {
      ...redispatched,
      runId: 'private/repo#42/r2',
      pipeline: 'codex',
    };
    const text = snapshot([redispatched, retry, redispatched]);
    for (const pipeline of ['claude', 'codex']) {
      expect(text).toContain(
        `lcars_product_redispatch_interventions_window{pipeline="${pipeline}"} 1\n`,
      );
      expect(text).toContain(
        `lcars_product_reply_interventions_window{pipeline="${pipeline}"} 0\n`,
      );
      expect(text).toContain(
        `lcars_product_measurement_unknown_window{pipeline="${pipeline}",measurement="redispatch_intervention"} 0\n`,
      );
    }
    expect(text).toContain('lcars_product_admitted_tasks_window 1\n');
    expect(text).toContain(
      'lcars_product_intervened_tasks_window{kind="work-api-redispatch"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_intervened_tasks_window{kind="any"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_task_intervention_unknown_window 0\n',
    );
    expect(text).not.toContain('svc:verified');
    expect(snapshot([redispatched], { complete: false })).not.toContain(
      'redispatch_interventions_window',
    );
  });

  it('keeps forged, automatic, old and invalid redispatch provenance unknown', () => {
    const event = {
      at: createdAt,
      to: 'pending' as const,
      by: 'request' as const,
      intervention: {
        kind: 'work-api-redispatch' as const,
        principal: 'svc:verified',
      },
    };
    const records = [
      run({ params: { mode: 'redispatch', principal: 'svc:forged' } }),
      run({ events: [event], requestSource: 'auto-retry' }),
      run({ events: [{ ...event, at: finishedAt }] }),
      run({
        events: [
          { ...event, intervention: { ...event.intervention, principal: '' } },
        ],
      }),
      run({ events: [event], updatedAt: '2026-10-10T12:00:00.001Z' }),
      run({ events: [event], updatedAt: '2026-10-10T11:39:59.999Z' }),
      run({ events: [event], createdAt: '2026-10-10T10:59:59.999Z' }),
    ].map((record, index) => ({
      ...record,
      runId: `private/repo#${index + 1}/r1`,
      task: { repo: 'private/repo', issue: index + 1 },
    }));
    const text = snapshot(records);
    expect(text).toContain(
      'lcars_product_redispatch_interventions_window{pipeline="claude"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="redispatch_intervention"} 6\n',
    );
    expect(text).toContain('lcars_product_admitted_tasks_window 6\n');
    expect(text).toContain(
      'lcars_product_intervened_tasks_window{kind="any"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_task_intervention_unknown_window 6\n',
    );
  });

  function replied(over: Partial<Run> = {}): Run {
    return run({
      events: [
        {
          at: createdAt,
          to: 'pending',
          by: 'request',
          intervention: {
            kind: 'work-api-reply',
            principal: 'svc:verified-operator',
          },
        },
      ],
      ...over,
    });
  }
  it('counts a typed reply admission once across feeds and leaves human identity unknown', () => {
    const original = replied({
      state: 'finished',
      events: [
        ...replied().events,
        { at: finishedAt, to: 'finished', by: 'report' },
      ],
      updatedAt: finishedAt,
    });
    const text = snapshot([original, original], { liveRuns: [original] });
    expect(text).toContain(
      'lcars_product_reply_interventions_window{pipeline="claude"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="reply_intervention"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="human_touch"} 1\n',
    );
    expect(text).not.toContain('svc:verified-operator');
  });
  it('counts distinct reply generations and keeps params-only/retry/legacy admissions unknown', () => {
    const text = snapshot([
      replied(),
      replied({ runId: 'private/repo#42/r2' }),
      run({
        runId: 'private/repo#42/r3',
        params: { mode: 'reply', replyPrincipal: 'user:forged' },
      }),
      replied({ runId: 'private/repo#42/r4', requestSource: 'auto-retry' }),
    ]);
    expect(text).toContain(
      'lcars_product_reply_interventions_window{pipeline="claude"} 2\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="reply_intervention"} 2\n',
    );
  });
  it.each([
    {
      name: 'revision before admission',
      over: { updatedAt: '2026-10-10T11:39:00.000Z' },
    },
    {
      name: 'future revision',
      over: { updatedAt: '2026-10-10T12:01:00.000Z' },
    },
    { name: 'invalid revision', over: { updatedAt: 'invalid' } },
    {
      name: 'stamp after first event',
      over: { events: [...run().events, ...replied().events] },
    },
    {
      name: 'wrong event clock',
      over: { events: [{ ...replied().events[0], at: finishedAt }] },
    },
    {
      name: 'wrong action kind',
      over: {
        events: [
          {
            ...replied().events[0],
            intervention: {
              kind: 'work-api-cancel' as const,
              principal: 'svc:operator',
            },
          },
        ],
      },
    },
  ])('keeps $name reply attribution unknown', ({ over }) => {
    const text = snapshot([replied(over)]);
    expect(text).toContain(
      'lcars_product_reply_interventions_window{pipeline="claude"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="reply_intervention"} 1\n',
    );
  });
  it('uses reply admission rather than settlement and suppresses incomplete reads', () => {
    const old = replied({
      createdAt: '2026-10-10T10:00:00.000Z',
      updatedAt: finishedAt,
    });
    expect(snapshot([old])).toContain(
      'lcars_product_reply_interventions_window{pipeline="claude"} 0\n',
    );
    expect(snapshot([replied()], { complete: false })).not.toContain(
      'reply_interventions_window',
    );
  });

  function canceled(intervention = true): Run {
    const original = run();
    const decision = cancelRun({
      now: finishedAt,
      task: {
        task: original.task,
        activeRunId: original.runId,
        runCount: 1,
        consecutiveLost: 0,
        work: {},
        updatedAt: createdAt,
      },
      run: original,
      ...(intervention
        ? {
            intervention: {
              kind: 'work-api-cancel' as const,
              principal: 'workflow:authorized-automation',
            },
          }
        : {}),
    });
    if (isRefusal(decision)) throw new Error(decision.reason);
    return decidedRun(decision);
  }
  it('exports an ingress-recorded cancellation once while keeping human identity unknown', () => {
    const original = canceled();
    const text = snapshot([original, original], { liveRuns: [run()] });
    expect(text).toContain(
      'lcars_product_operational_interventions_window{pipeline="claude",kind="work-api-cancel"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="operational_intervention"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="human_touch"} 1\n',
    );
    expect(text).not.toContain('authorized-automation');
    expect(snapshot([original, original], { liveRuns: [run()] })).toBe(text);
  });
  it('keeps untyped automated/legacy cancellation and worker text unknown', () => {
    const original = canceled(false);
    const text = snapshot([
      {
        ...original,
        params: { intervention: 'work-api-cancel' },
        result: { ok: true, summary: 'work-api-cancel' },
        events: original.events.map((event) => ({
          ...event,
          note: 'canceled by user:jlapenna; work-api-cancel',
        })),
      },
    ]);
    expect(text).toContain(
      'lcars_product_operational_interventions_window{pipeline="claude",kind="work-api-cancel"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="operational_intervention"} 1\n',
    );
  });
  it.each([
    { name: 'pre-admission', createdAt: '2026-10-10T11:46:00.000Z' },
    { name: 'before revision', updatedAt: '2026-10-10T11:44:00.000Z' },
    { name: 'future revision', updatedAt: '2026-10-10T12:00:00.001Z' },
    { name: 'invalid admission', createdAt: 'invalid' },
  ])('keeps $name intervention clocks unknown', ({ name: _name, ...over }) => {
    const text = snapshot([{ ...canceled(), ...over }]);
    expect(text).toContain(
      'lcars_product_operational_interventions_window{pipeline="claude",kind="work-api-cancel"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="operational_intervention"} 1\n',
    );
  });
  it('uses settlement rather than recent updates and suppresses incomplete intervention reads', () => {
    const original = canceled();
    const old = {
      ...original,
      createdAt: '2026-10-10T10:00:00.000Z',
      events: original.events.map((event) =>
        event.to === 'canceled'
          ? {
              ...event,
              at: '2026-10-10T10:59:59.999Z',
            }
          : event,
      ),
    };
    expect(snapshot([old])).toContain(
      'lcars_product_operational_interventions_window{pipeline="claude",kind="work-api-cancel"} 0\n',
    );
    expect(snapshot([original], { complete: false })).not.toContain(
      'operational_interventions_window',
    );
  });
  it('credits completed protected PR delivery from the canonical delivery state machine', () => {
    const original = delivered({ state: 'waiting', mergeCommit: undefined });
    const decision = advanceDelivery({
      now: deliveryAt,
      task: {
        task: original.task,
        delivery: original.delivery,
        runCount: 1,
        consecutiveLost: 0,
        work: {},
        updatedAt: finishedAt,
      },
      run: original,
      observation: {
        kind: 'protected-merge',
        head: 'a'.repeat(40),
        mergeCommit: 'b'.repeat(40),
      },
      correctionAuthorized: false,
    });
    if (isRefusal(decision)) throw new Error(decision.reason);
    expect(deliveryMeasurements(decidedRun(decision))).toEqual({
      completed: '1',
      unknown: '0',
    });
    expect(snapshot([decidedRun(decision)])).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="verified_evidence"} 1\n',
    );
  });
  it.each(['required', 'unknown'] as const)(
    'requires the authorized matching runtime observation for gate %s',
    (runtimeGate) => {
      const original = delivered({ state: 'runtime-required', runtimeGate });
      const task = {
        task: original.task,
        delivery: original.delivery,
        runCount: 1,
        consecutiveLost: 0,
        work: {},
        updatedAt: finishedAt,
      };
      expect(deliveryMeasurements(original)).toEqual({
        completed: '0',
        unknown: '1',
      });
      const decision = advanceDelivery({
        now: deliveryAt,
        task,
        run: original,
        observation: {
          kind: 'runtime-evidence',
          head: 'a'.repeat(40),
          mergeCommit: 'b'.repeat(40),
          principal: 'user:operator',
          ref: 'https://example.test/verified-runtime',
        },
        correctionAuthorized: true,
      });
      if (isRefusal(decision)) throw new Error(decision.reason);
      expect(deliveryMeasurements(decidedRun(decision))).toEqual({
        completed: '1',
        unknown: '0',
      });
    },
  );
  it.each([
    { name: 'wrong run', binding: { runId: 'private/repo#42/r2' } },
    { name: 'missing merge', binding: { mergeCommit: undefined } },
    { name: 'invalid head', binding: { head: 'not-a-head' } },
    { name: 'waiting', binding: { state: 'waiting' as const } },
    {
      name: 'runtime pending',
      binding: { state: 'runtime-required' as const },
    },
    {
      name: 'required without evidence',
      binding: { runtimeGate: 'required' as const },
    },
    {
      name: 'unknown without evidence',
      binding: { runtimeGate: 'unknown' as const },
    },
    { name: 'invalid observation', binding: { observedAt: 'invalid' } },
    {
      name: 'future observation',
      binding: { observedAt: '2026-10-10T12:00:00.001Z' },
    },
    {
      name: 'before admission',
      binding: { observedAt: '2026-10-10T11:39:59.999Z' },
    },
    {
      name: 'after run revision',
      binding: { observedAt: '2026-10-10T11:50:00.001Z' },
    },
    {
      name: 'runtime clock mismatch',
      binding: {
        runtimeGate: 'required' as const,
        runtimeEvidence: {
          principal: 'user:operator',
          ref: 'https://example.test/runtime',
          observedAt: finishedAt,
        },
      },
    },
    {
      name: 'future runtime evidence',
      binding: {
        runtimeGate: 'required' as const,
        runtimeEvidence: {
          principal: 'user:operator',
          ref: 'https://example.test/runtime',
          observedAt: '2026-10-10T12:00:00.001Z',
        },
      },
    },
  ])('keeps $name delivery evidence unknown', ({ binding }) => {
    expect(deliveryMeasurements(delivered(binding))).toEqual({
      completed: '0',
      unknown: '1',
    });
  });
  it.each(['park', 'no-op', 'review', 'comment', 'merged-deliverable'])(
    'does not credit a reported %s or PR-shaped ref without trusted delivery',
    (summary) => {
      const original = delivered();
      expect(
        deliveryMeasurements({
          ...original,
          delivery: undefined,
          result: {
            ok: true,
            summary,
            ref: 'https://github.com/private/repo/pull/99',
          },
        }),
      ).toEqual({ completed: '0', unknown: '1' });
    },
  );
  it.each(['park', 'no-op', 'review'])(
    'keeps inconsistent %s reports with delivery metadata unknown',
    (summary) => {
      expect(
        deliveryMeasurements({ ...delivered(), result: { ok: true, summary } }),
      ).toEqual({ completed: '0', unknown: '1' });
    },
  );
  it('does not credit failed results or a terminal event preceding admission', () => {
    expect(
      deliveryMeasurements({ ...delivered(), result: { ok: false } }),
    ).toEqual({ completed: '0', unknown: '1' });
    expect(
      deliveryMeasurements({
        ...delivered(),
        events: [
          { at: '2026-10-10T11:39:00.000Z', to: 'finished', by: 'report' },
        ],
      }),
    ).toEqual({ completed: '0', unknown: '1' });
  });
  it('accepts an already protected delivery observed before execution settlement', () => {
    expect(deliveryMeasurements(delivered({ observedAt: createdAt }))).toEqual({
      completed: '1',
      unknown: '0',
    });
  });
  it('uses the finished-hour cohort rather than a recent delivery update for old settlements', () => {
    const original: Run = {
      ...delivered(),
      createdAt: '2026-10-10T10:40:00.000Z',
      events: [
        {
          at: '2026-10-10T10:59:59.999Z',
          to: 'finished' as const,
          by: 'report',
        },
      ],
    };
    expect(deliveryMeasurements(original)).toEqual({
      completed: '0',
      unknown: '0',
    });
  });
  it('deduplicates delivery by run identity and uses the newest observed revision', () => {
    const original = delivered();
    const text = snapshot([original, original], { liveRuns: [original] });
    expect(text).toContain(
      'lcars_product_completed_pr_delivery_window{pipeline="claude"} 1\n',
    );
    const newer = {
      ...original,
      updatedAt: '2026-10-10T11:51:00.000Z',
      delivery: { ...original.delivery, state: 'runtime-required' as const },
    };
    expect(snapshot([original, newer])).toContain(
      'lcars_product_completed_pr_delivery_window{pipeline="claude"} 0\n',
    );
    expect(snapshot([newer, original])).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="useful_outcome"} 1\n',
    );
    expect(text).not.toMatch(
      /private\/repo|verified-runtime|user:operator|head=/u,
    );
    expect(snapshot([original], { complete: false })).not.toContain(
      'lcars_product_completed_pr_delivery_window',
    );
  });
  it('measures admission to trusted final delivery observation over the finished cohort', () => {
    const text = snapshot([
      delivered(),
      {
        ...delivered(),
        runId: 'private/repo#42/r2',
        delivery: {
          ...delivered().delivery,
          runId: 'private/repo#42/r2',
          observedAt: createdAt,
        },
        requestSource: 'auto-retry',
      },
    ]);
    expect(text).toContain(
      'lcars_product_latency_window_observations{pipeline="claude",stage="admission_to_completed_pr_delivery"} 2\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_duration_seconds{pipeline="claude",stage="admission_to_completed_pr_delivery"} 600\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_samples{pipeline="claude",stage="admission_to_completed_pr_delivery",upper_bound_seconds="300"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_samples{pipeline="claude",stage="admission_to_completed_pr_delivery",upper_bound_seconds="900"} 2\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_unknown{pipeline="claude",stage="admission_to_completed_pr_delivery"} 0\n',
    );
  });
  it('keeps unqualified members unknown rather than zero-latency or reported success', () => {
    const bindingChanges: Partial<DeliveryBinding>[] = [
      { state: 'waiting' },
      { state: 'runtime-required', runtimeGate: 'required' },
      { runId: 'wrong-run' },
      { mergeCommit: undefined },
      { observedAt: 'invalid' },
      { observedAt: '2026-10-10T11:39:59.999Z' },
      { observedAt: '2026-10-10T12:00:00.001Z' },
      { observedAt: '2026-10-10T11:50:00.001Z' },
    ];
    const unqualified = bindingChanges.map((binding, i) => {
      const original = delivered(binding);
      return {
        ...original,
        runId: `private/repo#${100 + i}/r1`,
        delivery: {
          ...original.delivery,
          runId: binding.runId ?? `private/repo#${100 + i}/r1`,
        },
      };
    });
    const park = {
      ...delivered({ runId: 'park' }),
      runId: 'park',
      result: { ok: true, summary: 'park' },
    };
    const raw = { ...delivered(), runId: 'raw', delivery: undefined };
    const text = snapshot([...unqualified, park, raw]);
    expect(text).toContain(
      'lcars_product_latency_window_observations{pipeline="claude",stage="admission_to_completed_pr_delivery"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_unknown{pipeline="claude",stage="admission_to_completed_pr_delivery"} 10\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_duration_seconds{pipeline="claude",stage="admission_to_completed_pr_delivery"} 0\n',
    );
  });
  it('uses authorized runtime completion time and newest revision once per attempt', () => {
    const waiting = delivered({
      state: 'runtime-required',
      runtimeGate: 'required',
    });
    const decision = advanceDelivery({
      now: '2026-10-10T11:55:00.000Z',
      task: {
        task: waiting.task,
        delivery: waiting.delivery,
        runCount: 1,
        consecutiveLost: 0,
        work: {},
        updatedAt: deliveryAt,
      },
      run: waiting,
      observation: {
        kind: 'runtime-evidence',
        head: waiting.delivery.head,
        mergeCommit: 'b'.repeat(40),
        principal: 'user:operator',
        ref: 'https://example.test/runtime',
      },
      correctionAuthorized: true,
    });
    if (isRefusal(decision)) throw new Error(decision.reason);
    const completed = decidedRun(decision);
    const text = snapshot([waiting, completed, completed], {
      liveRuns: [waiting],
    });
    expect(text).toContain(
      'lcars_product_latency_window_observations{pipeline="claude",stage="admission_to_completed_pr_delivery"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_duration_seconds{pipeline="claude",stage="admission_to_completed_pr_delivery"} 900\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_unknown{pipeline="claude",stage="admission_to_completed_pr_delivery"} 0\n',
    );
  });
  it('excludes old settlements with recent delivery and incomplete reads from delivery latency', () => {
    const old: Run = {
      ...delivered(),
      createdAt: '2026-10-10T10:00:00.000Z',
      events: [
        { at: '2026-10-10T10:59:59.999Z', to: 'finished', by: 'report' },
      ],
    };
    const text = snapshot([old]);
    expect(text).toContain(
      'lcars_product_latency_window_observations{pipeline="claude",stage="admission_to_completed_pr_delivery"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_unknown{pipeline="claude",stage="admission_to_completed_pr_delivery"} 0\n',
    );
    expect(snapshot([delivered()], { complete: false })).not.toContain(
      'admission_to_completed_pr_delivery',
    );
  });
  it('declares help and gauge types without reserved histogram names or labels', () => {
    for (const text of [snapshot([run()]), snapshot([], { complete: false })]) {
      const names = new Set(
        text
          .split('\n')
          .filter((line) => line.startsWith('lcars_product_'))
          .map((line) => line.split(/[ {]/u)[0]),
      );
      for (const name of names) {
        expect(text).toContain(`# HELP ${name} `);
        expect(text).toContain(`# TYPE ${name} gauge\n`);
        expect(name).not.toMatch(/_(?:bucket|count|sum)$/u);
      }
      expect(text).not.toMatch(/[{,]le=/u);
    }
  });
  it('deduplicates recent/live feeds, idempotency replays and repeated exports without dynamic labels', () => {
    const original = run();
    const text = snapshot([original, original]);
    expect(snapshot([original, original])).toBe(text);
    expect(text).toContain(
      'lcars_product_admitted_window{pipeline="claude"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_live_runs{pipeline="claude",state="queued"} 1\n',
    );
    expect(text).not.toMatch(/private|requestId|tokenHash|runId|repo=/u);
    expect(text).not.toContain(' counter');
  });
  it('measures persisted queue confirmation and retained claims, not running/provider launch', () => {
    const claimed = run({
      queue: { state: 'claimed', claimedAt: '2026-10-10T11:42:00.000Z' },
    });
    const text = snapshot([claimed]);
    expect(text).toContain(
      'lcars_product_latency_window_duration_seconds{pipeline="claude",stage="admission_to_queue"} 30\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_duration_seconds{pipeline="claude",stage="queue_to_claim"} 90\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_samples{pipeline="claude",stage="queue_to_claim",upper_bound_seconds="60"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_samples{pipeline="claude",stage="queue_to_claim",upper_bound_seconds="120"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="provider_start"} 1\n',
    );
  });
  it('excludes capacity waits from silent loss and separates automatic retry admissions', () => {
    const expired = '2026-10-10T11:00:00.000Z';
    const queued = run({ leaseExpiresAt: expired });
    const claimed = run({
      runId: 'private/repo#43/r1',
      queue: { state: 'claimed', claimedAt: createdAt },
      leaseExpiresAt: expired,
    });
    const retry = run({
      runId: 'private/repo#43/r2',
      requestSource: 'auto-retry',
    });
    const lost = run({
      runId: 'private/repo#44/r1',
      state: 'lost',
      events: [{ at: createdAt, by: 'expiry', to: 'lost' }],
    });
    const text = snapshot([queued, claimed, retry, lost]);
    expect(text).toContain(
      'lcars_product_silent_loss_runs{pipeline="claude"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_auto_retries_window{pipeline="claude"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_settled_window{pipeline="claude",state="lost"} 1\n',
    );
  });
  it('uses retained server spawn clocks, keeping bootstrap and invalid clocks unknown', () => {
    const claim = '2026-10-10T11:42:00.000Z';
    const spawn = '2026-10-10T11:42:08.000Z';
    const queues: Run['queue'][] = [
      { state: 'claimed', claimedAt: claim, providerProcessStartedAt: spawn },
      {
        state: 'claimed',
        claimedAt: '2026-10-10T10:59:00.000Z',
        providerProcessStartedAt: '2026-10-10T11:00:05.000Z',
      },
      { state: 'claimed', claimedAt: claim },
      { state: 'claimed', claimedAt: claim, firstHeartbeatAt: spawn },
      {
        state: 'claimed',
        claimedAt: claim,
        providerProcessStartedAt: '2026-10-10T11:41:59.000Z',
      },
      {
        state: 'claimed',
        claimedAt: claim,
        providerProcessStartedAt: '2026-10-10T12:00:00.001Z',
      },
      { state: 'claimed', providerProcessStartedAt: spawn },
      {
        state: 'claimed',
        claimedAt: '2026-10-10T11:39:00.000Z',
        providerProcessStartedAt: '2026-10-10T11:39:30.000Z',
      },
    ];
    const runs = queues.map((queue, i) =>
      run({
        runId: `spawn-${i}`,
        queue,
        ...(i === 1
          ? {
              createdAt: '2026-10-10T10:50:00.000Z',
              events: [
                {
                  at: '2026-10-10T10:50:30.000Z',
                  to: 'running',
                  by: 'dispatch',
                },
              ],
            }
          : {}),
      }),
    );
    const text = snapshot([...runs, runs[0]]);
    expect(text).toContain(
      'lcars_product_provider_starts_window{pipeline="claude"} 2\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_observations{pipeline="claude",stage="claim_to_provider_start"} 2\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_duration_seconds{pipeline="claude",stage="claim_to_provider_start"} 73\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_unknown{pipeline="claude",stage="claim_to_provider_start"} 6\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="provider_start"} 6\n',
    );
    expect(snapshot(runs, { complete: false })).not.toContain(
      'lcars_product_provider_starts_window',
    );
  });
  it('counts park/no-op/provider-limit separately from reported artifacts and leaves evidence unknown', () => {
    const runs = [
      'park',
      'no-op',
      'provider-limit',
      'pull-request',
      'merged-deliverable',
      'unknown-success',
    ].map((summary, i) =>
      run({
        runId: `private/repo#${50 + i}/r1`,
        state: 'finished',
        result: {
          ok: true,
          summary,
          ref: 'https://github.com/private/repo/pull/999',
        },
        events: [{ at: createdAt, to: 'finished', by: 'report' }],
      }),
    );
    const text = snapshot(runs);
    for (const outcome of [
      'park',
      'no-op',
      'provider-limit',
      'pull-request',
      'merged-deliverable',
      'unknown-success',
    ])
      expect(text).toContain(
        `lcars_product_reported_outcome_window{pipeline="claude",outcome="${outcome}"} 1\n`,
      );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="verified_evidence"} 6\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="useful_outcome"} 6\n',
    );
  });
  it('does not count outbox claims or expired lease recovery as delivery failures', () => {
    const base: OutboxEntry = {
      entryId: 'dispatch/private/repo#42/r1',
      kind: 'dispatch-run',
      task: { repo: 'private/repo', issue: 42 },
      runId: 'private/repo#42/r1',
      state: 'pending',
      attempts: 90,
      createdAt,
      updatedAt: createdAt,
    };
    const failed: OutboxEntry = {
      ...base,
      entryId: 'report/private/repo#42/r1',
      kind: 'report-outcome',
      state: 'failed',
      deliveryFailures: 3,
    };
    const text = snapshot([], { outstandingOutbox: [base, base, failed] });
    expect(text).toContain(
      'lcars_product_outbox_entries{kind="dispatch-run",state="pending"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_outbox_recorded_delivery_failures{kind="dispatch-run"} 0\n',
    );
    expect(text).toContain(
      'lcars_product_outbox_entries{kind="report-outcome",state="failed"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_outbox_recorded_delivery_failures{kind="report-outcome"} 3\n',
    );
  });
  it('suppresses healthy-looking series on truncation and folds arbitrary provider names into unknown', () => {
    const arbitrary = run({ pipeline: 'private-provider-user-123' });
    expect(snapshot([arbitrary])).toContain(
      'lcars_product_admitted_window{pipeline="unknown"} 1\n',
    );
    expect(snapshot([arbitrary])).not.toContain('private-provider');
    const incomplete = snapshot([arbitrary], { complete: false });
    expect(incomplete).toContain('lcars_product_snapshot_complete 0\n');
    expect(incomplete).not.toContain('lcars_product_silent_loss_runs');
    expect(incomplete).not.toContain('lcars_product_outbox_entries');
  });
  it('excludes old/future events and reports malformed or missing latency clocks as unknown', () => {
    const missing = run({
      queue: { state: 'claimed', claimedAt: createdAt },
      events: [],
    });
    const old = run({
      runId: 'old',
      createdAt: '2026-10-10T10:59:59.999Z',
      queue: { state: 'claimed', claimedAt: '2026-10-10T12:00:00.001Z' },
    });
    const text = snapshot([missing, old]);
    expect(text).toContain(
      'lcars_product_admitted_window{pipeline="claude"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_claims_window{pipeline="claude"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_unknown{pipeline="claude",stage="queue_to_claim"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_latency_window_unknown{pipeline="claude",stage="admission_to_queue"} 1\n',
    );
  });
});

describe('unique task operational intervention cohort', () => {
  function reply(over: Partial<Run> = {}): Run {
    return run({
      events: [
        {
          at: createdAt,
          to: 'pending',
          by: 'request',
          intervention: {
            kind: 'work-api-reply',
            principal: 'svc:verified-operator',
          },
        },
      ],
      ...over,
    });
  }
  function cancel(over: Partial<Run> = {}): Run {
    return run({
      state: 'canceled',
      updatedAt: finishedAt,
      events: [
        { at: createdAt, to: 'pending', by: 'request' },
        {
          at: finishedAt,
          to: 'canceled',
          by: 'operator',
          intervention: {
            kind: 'work-api-cancel',
            principal: 'svc:verified-operator',
          },
        },
      ],
      ...over,
    });
  }
  function taskMeasurements(text: string) {
    const value = (name: string) =>
      Number(text.match(new RegExp(`${name} (\\d+)\\n`, 'u'))?.[1]);
    return {
      admitted: value('lcars_product_admitted_tasks_window'),
      reply: value(
        'lcars_product_intervened_tasks_window\\{kind="work-api-reply"\\}',
      ),
      cancel: value(
        'lcars_product_intervened_tasks_window\\{kind="work-api-cancel"\\}',
      ),
      any: value('lcars_product_intervened_tasks_window\\{kind="any"\\}'),
      unknown: value('lcars_product_task_intervention_unknown_window'),
    };
  }
  it('deduplicates the distinct task cohort across retries, providers and overlapping action kinds', () => {
    const records = [
      reply(),
      cancel({
        runId: 'private/repo#42/r2',
        pipeline: 'codex',
        requestSource: 'auto-retry',
      }),
      reply({ runId: 'private/repo#42/r3', pipeline: 'opencode' }),
      reply({
        runId: 'other/repo#42/r1',
        task: { repo: 'other/repo', issue: 42 },
      }),
      run({
        runId: 'work:01ARZ3NDEKTSV4RRFFQ69G5FAV/r1',
        task: { workId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      }),
    ];
    const text = snapshot([...records, ...records]);
    const measured = taskMeasurements(text);
    expect(measured).toEqual({
      admitted: 3,
      reply: 2,
      cancel: 1,
      any: 2,
      unknown: 1,
    });
    expect(measured.any + measured.unknown).toBe(measured.admitted);
    const singleFeed = snapshot(records);
    expect(taskMeasurements(singleFeed)).toEqual(measured);
    expect(singleFeed).toContain(
      'lcars_product_snapshot_records{feed="recent_runs"} 5\n',
    );
    expect(text).toContain(
      'lcars_product_snapshot_records{feed="recent_runs"} 10\n',
    );
    expect(text).not.toContain('svc:verified-operator');
    expect(text).not.toContain('private/repo');
    expect(text).not.toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });
  it('excludes an older admission cancellation from task credit while retaining the settled-run count', () => {
    const old = cancel({ createdAt: '2026-10-10T10:30:00.000Z' });
    const current = run({
      runId: 'private/repo#42/r2',
      requestSource: 'auto-retry',
    });
    const text = snapshot([old, current]);
    expect(taskMeasurements(text)).toEqual({
      admitted: 1,
      reply: 0,
      cancel: 0,
      any: 0,
      unknown: 1,
    });
    expect(text).toContain(
      'lcars_product_operational_interventions_window{pipeline="claude",kind="work-api-cancel"} 1\n',
    );
    expect(text).toContain(
      'lcars_product_measurement_unknown_window{pipeline="claude",measurement="human_touch"} 1\n',
    );
  });
  it('uses inclusive admission bounds without treating settlement as admission', () => {
    const times = [
      '2026-10-10T10:59:59.999Z',
      '2026-10-10T11:00:00.000Z',
      NOW,
      '2026-10-10T12:00:00.001Z',
      'invalid',
    ];
    const records = times.map((at, i) =>
      run({
        runId: `private/repo#${i + 1}/r1`,
        task: { repo: 'private/repo', issue: i + 1 },
        createdAt: at,
      }),
    );
    expect(taskMeasurements(snapshot(records))).toEqual({
      admitted: 2,
      reply: 0,
      cancel: 0,
      any: 0,
      unknown: 2,
    });
  });
  it('uses the newest Run revision before classifying a task and does not recover stale provenance', () => {
    const old = reply();
    const current = run({ updatedAt: finishedAt });
    expect(taskMeasurements(snapshot([old], { liveRuns: [current] }))).toEqual({
      admitted: 1,
      reply: 0,
      cancel: 0,
      any: 0,
      unknown: 1,
    });
    expect(taskMeasurements(snapshot([current], { liveRuns: [old] }))).toEqual({
      admitted: 1,
      reply: 0,
      cancel: 0,
      any: 0,
      unknown: 1,
    });
  });
  it.each([
    ['missing provenance', run()],
    [
      'reply revision before admission',
      reply({ updatedAt: '2026-10-10T11:39:59.999Z' }),
    ],
    ['future reply revision', reply({ updatedAt: '2026-10-10T12:00:00.001Z' })],
    [
      'wrong reply event clock',
      reply({ events: [{ ...reply().events[0], at: finishedAt }] }),
    ],
    ['retry carrying a reply stamp', reply({ requestSource: 'auto-retry' })],
    [
      'cancel settlement before admission',
      cancel({
        events: [{ ...cancel().events[1], at: '2026-10-10T11:39:59.999Z' }],
      }),
    ],
    [
      'future cancel revision',
      cancel({ updatedAt: '2026-10-10T12:00:00.001Z' }),
    ],
    [
      'unverified cancel principal',
      cancel({
        events: [
          {
            ...cancel().events[1],
            intervention: { kind: 'work-api-cancel', principal: '' },
          },
        ],
      }),
    ],
  ])(
    'keeps %s unknown rather than claiming an untouched task',
    (_name, record) => {
      const measured = taskMeasurements(snapshot([record as Run]));
      expect(measured).toEqual({
        admitted: 1,
        reply: 0,
        cancel: 0,
        any: 0,
        unknown: 1,
      });
    },
  );
  it('omits every derived task gauge when any bounded feed is incomplete', () => {
    const text = snapshot([reply()], { complete: false });
    for (const metric of [
      'admitted_tasks_window',
      'intervened_tasks_window',
      'task_intervention_unknown_window',
    ]) {
      expect(text).not.toContain(`lcars_product_${metric}`);
    }
  });
});
