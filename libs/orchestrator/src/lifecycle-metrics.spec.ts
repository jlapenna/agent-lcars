import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal } from './decide';
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
