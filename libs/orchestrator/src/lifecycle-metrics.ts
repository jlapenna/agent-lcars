import { isLive, type OutboxEntry, type Run } from './model';

/** Each query reads at most limit+1 documents; overflow fails closed. */
export const LIFECYCLE_METRICS_READ_LIMIT = 1_000;
export const LIFECYCLE_METRICS_WINDOW_SECONDS = 3_600;
const PIPELINES = ['claude', 'codex', 'opencode', 'unknown'] as const;
const OUTCOMES = [
  'pull-request',
  'merged-deliverable',
  'comment',
  'review',
  'park',
  'no-op',
  'provider-limit',
  'runner-failed',
  'agent-failed',
  'no-deliverable',
  'unknown-success',
  'other',
] as const;
const BUCKETS = [60, 120, 300, 900, 3_600] as const;
const HELP = {
  snapshot_complete:
    'One for untruncated durable reads, zero for incomplete reads.',
  snapshot_observed_timestamp_seconds:
    'Snapshot observation time in Unix seconds.',
  snapshot_records: 'Records returned by each bounded durable feed.',
  admitted_window: 'Run identities admitted during the rolling hour.',
  auto_retries_window:
    'Automatic retry generations admitted during the rolling hour.',
  claims_window:
    'Retained claims timestamped during the rolling hour, not all claim attempts.',
  terminal_clock_unknown_window:
    'Recently updated terminal runs without a valid terminal event clock.',
  settled_window:
    'Run identities whose current terminal event falls in the rolling hour.',
  live_runs: 'Currently live run identities by queue state.',
  silent_loss_runs:
    'Non-queued live runs with leases overdue beyond the recovery interval.',
  oldest_queued_seconds: 'Oldest queued run age since admission in seconds.',
  latency_window_samples:
    'Known rolling-hour latency samples at or below upper_bound_seconds; a gauge, not a histogram.',
  latency_window_observations:
    'Known nonnegative latency observations in the rolling hour.',
  latency_window_duration_seconds:
    'Sum of known rolling-hour latency durations in seconds; a decreasing gauge.',
  latency_window_unknown:
    'Rolling-hour latency candidates with missing or reversed clocks.',
  reported_outcome_window:
    'Finished rolling-hour run identities by worker-reported outcome, not verified usefulness.',
  measurement_unknown_window:
    'Rolling-hour run identities whose named measurement is unavailable.',
  outbox_entries: 'Outstanding durable outbox entries by kind and state.',
  outbox_oldest_seconds:
    'Oldest outstanding outbox entry age since creation in seconds.',
  outbox_recorded_delivery_failures:
    'Persisted delivery failures summed over outstanding outbox entries; a stock gauge.',
} as const;

function terminalAt(run: Run): string | undefined {
  return [...run.events].reverse().find((event) => event.to === run.state)?.at;
}

export interface LifecycleMetricRecords {
  readonly recentRuns: readonly Run[];
  readonly liveRuns: readonly Run[];
  readonly outstandingOutbox: readonly OutboxEntry[];
  readonly complete: boolean;
}

export interface LifecycleMetricRead {
  readonly since: string;
  readonly until: string;
  readonly limit: number;
}

export function validateLifecycleMetricRead(input: LifecycleMetricRead): void {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > LIFECYCLE_METRICS_READ_LIMIT ||
    !Number.isFinite(Date.parse(input.since)) ||
    !Number.isFinite(Date.parse(input.until)) ||
    input.since > input.until
  )
    throw new Error('Invalid lifecycle metric read bounds');
}

/** Rolling-window GAUGES derived from durable identities, never process-local
 * counters. Repeated exports and HTTP/idempotency retries do not add events.
 * Completeness means untruncated reads, not a cross-query atomic snapshot. */
export function lifecycleMetricSnapshot(
  records: LifecycleMetricRecords,
  observedAt: string,
) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('Invalid observation clock');
  const since = now - LIFECYCLE_METRICS_WINDOW_SECONDS * 1_000;
  const lines: string[] = [];
  const declared = new Set<string>();
  function gauge(
    name: keyof typeof HELP,
    value: number,
    labels: Record<string, string> = {},
  ) {
    const metric = `lcars_product_${name}`;
    if (!declared.has(metric)) {
      lines.push(`# HELP ${metric} ${HELP[name]}`);
      lines.push(`# TYPE ${metric} gauge`);
      declared.add(metric);
    }
    const suffix = Object.entries(labels)
      .map(([key, val]) => `${key}="${val}"`)
      .join(',');
    lines.push(`${metric}${suffix ? `{${suffix}}` : ''} ${value}`);
  }
  gauge('snapshot_complete', records.complete ? 1 : 0);
  gauge('snapshot_observed_timestamp_seconds', now / 1_000);
  gauge('snapshot_records', records.recentRuns.length, { feed: 'recent_runs' });
  gauge('snapshot_records', records.liveRuns.length, { feed: 'live_runs' });
  gauge('snapshot_records', records.outstandingOutbox.length, {
    feed: 'outstanding_outbox',
  });
  if (records.complete) {
    // A live run may also be recent. Keep one durable identity, using the
    // newest observed revision if a transition raced the separate queries.
    const byId = new Map<string, Run>();
    for (const run of [...records.recentRuns, ...records.liveRuns]) {
      const previous = byId.get(run.runId);
      if (previous === undefined || run.updatedAt >= previous.updatedAt)
        byId.set(run.runId, run);
    }
    const inWindow = (at: string | undefined) =>
      at !== undefined && Date.parse(at) >= since && Date.parse(at) <= now;
    const pipelineFor = (run: Run) =>
      PIPELINES.find((pipeline) => pipeline === run.pipeline) ?? 'unknown';
    for (const pipeline of PIPELINES) {
      const runs = [...byId.values()].filter(
        (run) => pipelineFor(run) === pipeline,
      );
      const admitted = runs.filter((run) => inWindow(run.createdAt));
      const claimed = runs.filter((run) => inWindow(run.queue?.claimedAt));
      const terminal = runs.filter(
        (run) => !isLive(run.state) && inWindow(terminalAt(run)),
      );
      const live = runs.filter((run) => isLive(run.state));
      gauge('admitted_window', admitted.length, { pipeline });
      gauge(
        'auto_retries_window',
        admitted.filter((run) => run.requestSource === 'auto-retry').length,
        { pipeline },
      );
      gauge('claims_window', claimed.length, { pipeline });
      gauge(
        'terminal_clock_unknown_window',
        runs.filter(
          (run) =>
            !isLive(run.state) &&
            inWindow(run.updatedAt) &&
            !Number.isFinite(Date.parse(terminalAt(run) ?? '')),
        ).length,
        { pipeline },
      );
      for (const state of [
        'pending',
        'running',
        'finished',
        'canceled',
        'lost',
      ] as const) {
        if (isLive(state)) continue;
        gauge(
          'settled_window',
          terminal.filter((run) => run.state === state).length,
          { pipeline, state },
        );
      }
      for (const state of ['queued', 'claimed', 'unclassified'] as const) {
        gauge(
          'live_runs',
          live.filter((run) => (run.queue?.state ?? 'unclassified') === state)
            .length,
          { pipeline, state },
        );
      }
      // Queued capacity waits deliberately do not expire execution leases.
      gauge(
        'silent_loss_runs',
        live.filter(
          (run) =>
            run.queue?.state !== 'queued' &&
            Date.parse(run.leaseExpiresAt) + 300_000 < now,
        ).length,
        { pipeline },
      );
      const queued = live.filter((run) => run.queue?.state === 'queued');
      gauge(
        'oldest_queued_seconds',
        Math.max(
          0,
          ...queued.map((run) => (now - Date.parse(run.createdAt)) / 1_000),
        ),
        { pipeline },
      );
      for (const stage of ['admission_to_queue', 'queue_to_claim'] as const) {
        const candidates =
          stage === 'admission_to_queue'
            ? runs.filter((run) => {
                const dispatched = run.events.find(
                  (event) => event.by === 'dispatch',
                )?.at;
                return (
                  inWindow(dispatched) ||
                  (dispatched === undefined &&
                    run.queue !== undefined &&
                    inWindow(run.createdAt))
                );
              })
            : claimed;
        const durations: number[] = [];
        for (const run of candidates) {
          const dispatched = run.events.find(
            (event) => event.by === 'dispatch',
          )?.at;
          const start =
            stage === 'admission_to_queue' ? run.createdAt : dispatched;
          const end =
            stage === 'admission_to_queue' ? dispatched : run.queue?.claimedAt;
          const seconds =
            start === undefined || end === undefined
              ? NaN
              : (Date.parse(end) - Date.parse(start)) / 1_000;
          if (Number.isFinite(seconds) && seconds >= 0) durations.push(seconds);
        }
        for (const bound of BUCKETS)
          gauge(
            'latency_window_samples',
            durations.filter((seconds) => seconds <= bound).length,
            { pipeline, stage, upper_bound_seconds: String(bound) },
          );
        gauge('latency_window_samples', durations.length, {
          pipeline,
          stage,
          upper_bound_seconds: '+Inf',
        });
        gauge('latency_window_observations', durations.length, {
          pipeline,
          stage,
        });
        gauge(
          'latency_window_duration_seconds',
          durations.reduce((sum, seconds) => sum + seconds, 0),
          { pipeline, stage },
        );
        gauge('latency_window_unknown', candidates.length - durations.length, {
          pipeline,
          stage,
        });
      }
      const finished = terminal.filter((run) => run.state === 'finished');
      for (const outcome of OUTCOMES) {
        gauge(
          'reported_outcome_window',
          finished.filter((run) => {
            const summary = run.result?.summary;
            const category =
              OUTCOMES.find(
                (value) => value !== 'other' && value === summary,
              ) ?? 'other';
            return category === outcome;
          }).length,
          { pipeline, outcome },
        );
      }
      // These facts are NOT in this ledger. Never turn ok=true, a PR-shaped
      // ref, a bootstrap heartbeat or a claim into evidence/start/merge/cost.
      for (const [measurement, count] of [
        ['provider_start', claimed.length],
        ['verified_evidence', finished.length],
        ['useful_outcome', finished.length],
        ['human_touch', terminal.length],
        ['cost', finished.length],
      ] as const)
        gauge('measurement_unknown_window', count, { pipeline, measurement });
    }
    const outbox = [
      ...new Map(
        records.outstandingOutbox.map((entry) => [entry.entryId, entry]),
      ).values(),
    ];
    for (const kind of ['dispatch-run', 'report-outcome'] as const) {
      const entries = outbox.filter((entry) => entry.kind === kind);
      for (const state of ['pending', 'leased', 'failed'] as const)
        gauge(
          'outbox_entries',
          entries.filter((entry) => entry.state === state).length,
          { kind, state },
        );
      gauge(
        'outbox_oldest_seconds',
        Math.max(
          0,
          ...entries.map(
            (entry) => (now - Date.parse(entry.createdAt)) / 1_000,
          ),
        ),
        { kind },
      );
      // A claim/expired-lease recovery is not an actual delivery failure.
      gauge(
        'outbox_recorded_delivery_failures',
        entries.reduce((sum, entry) => sum + (entry.deliveryFailures ?? 0), 0),
        { kind },
      );
    }
  }
  return {
    observedAt,
    windowSeconds: LIFECYCLE_METRICS_WINDOW_SECONDS as 3600,
    complete: records.complete,
    prometheus: `${lines.join('\n')}\n`,
  };
}
