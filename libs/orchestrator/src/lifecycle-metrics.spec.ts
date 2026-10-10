import { describe, expect, it } from 'vitest';

import {
  type LifecycleMetricRecords,
  lifecycleMetricSnapshot,
} from './lifecycle-metrics';
import { type OutboxEntry, type Run } from './model';

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

describe('durable lifecycle metric accounting', () => {
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
