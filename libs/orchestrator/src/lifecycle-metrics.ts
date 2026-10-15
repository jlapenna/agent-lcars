import {
  deliveryBindingSchema,
  isLive,
  operationalInterventionSchema,
  type OutboxEntry,
  type Run,
} from './model';

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
  'provider-capacity',
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
  provider_starts_window:
    'Retained server-observed provider OS spawns during the rolling hour, not authentication or model execution.',
  operational_interventions_window:
    'Settled rolling-hour run identities with a typed server-recorded authorized API intervention, not a human-touch or unique-task rate.',
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
    'Rolling-hour latency candidates with missing, invalid, reversed or future clocks.',
  reported_outcome_window:
    'Finished rolling-hour run identities by worker-reported outcome, not verified usefulness.',
  completed_pr_delivery_window:
    'Finished rolling-hour run identities with trusted completed PR delivery, not all useful outcomes or delivery-observation events.',
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

/** DeliveryBinding is written by the exact-attempt server verifier and trusted
 * delivery observations. Worker summaries and PR-shaped refs supply no credit. */
function completedPullRequestDelivery(run: Run, now: number): boolean {
  const parsed = deliveryBindingSchema.safeParse(run.delivery);
  if (
    !parsed.success ||
    run.state !== 'finished' ||
    !run.result?.ok ||
    ['park', 'no-op', 'review'].includes(run.result.summary ?? '') ||
    run.params?.mode === 'review'
  )
    return false;
  const binding = parsed.data;
  const admission = Date.parse(run.createdAt);
  const settlement = Date.parse(terminalAt(run) ?? '');
  const observation = Date.parse(binding.observedAt);
  const updated = Date.parse(run.updatedAt);
  if (
    binding.runId !== run.runId ||
    binding.state !== 'complete' ||
    binding.mergeCommit === undefined ||
    !Number.isFinite(admission) ||
    !Number.isFinite(settlement) ||
    !Number.isFinite(observation) ||
    !Number.isFinite(updated) ||
    settlement < admission ||
    settlement > updated ||
    observation < admission ||
    observation > updated ||
    observation > now
  )
    return false;
  if (binding.runtimeGate === 'none')
    return binding.runtimeEvidence === undefined;
  // advanceDelivery records both clocks from the same authorized observation.
  return (
    binding.runtimeEvidence !== undefined &&
    Number.isFinite(Date.parse(binding.runtimeEvidence.observedAt)) &&
    Date.parse(binding.runtimeEvidence.observedAt) === observation
  );
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
    const providerStarted = (run: Run) => {
      const start = Date.parse(run.queue?.providerProcessStartedAt ?? '');
      const claim = Date.parse(run.queue?.claimedAt ?? '');
      const admission = Date.parse(run.createdAt);
      return (
        Number.isFinite(start) &&
        Number.isFinite(claim) &&
        Number.isFinite(admission) &&
        start >= claim &&
        start >= admission &&
        start <= now
      );
    };
    for (const pipeline of PIPELINES) {
      const runs = [...byId.values()].filter(
        (run) => pipelineFor(run) === pipeline,
      );
      const admitted = runs.filter((run) => inWindow(run.createdAt));
      const claimed = runs.filter((run) => inWindow(run.queue?.claimedAt));
      const terminal = runs.filter(
        (run) => !isLive(run.state) && inWindow(terminalAt(run)),
      );
      // by=operator also covers automated anchor closure and provider switches.
      // Only the authenticated ingress's typed durable fact earns credit.
      const interventions = terminal.filter((run) => {
        const event = [...run.events]
          .reverse()
          .find((value) => value.to === run.state);
        const admission = Date.parse(run.createdAt);
        const settlement = Date.parse(event?.at ?? '');
        const updated = Date.parse(run.updatedAt);
        return (
          run.state === 'canceled' &&
          event?.by === 'operator' &&
          operationalInterventionSchema.safeParse(event.intervention).success &&
          Number.isFinite(admission) &&
          Number.isFinite(updated) &&
          admission <= settlement &&
          settlement <= updated &&
          updated <= now
        );
      });
      gauge('operational_interventions_window', interventions.length, {
        pipeline,
        kind: 'work-api-cancel',
      });
      const live = runs.filter((run) => isLive(run.state));
      gauge('admitted_window', admitted.length, { pipeline });
      gauge(
        'auto_retries_window',
        admitted.filter((run) => run.requestSource === 'auto-retry').length,
        { pipeline },
      );
      gauge('claims_window', claimed.length, { pipeline });
      const started = runs.filter(
        (run) =>
          providerStarted(run) && inWindow(run.queue?.providerProcessStartedAt),
      );
      const providerStartCandidates = runs.filter(
        (run) =>
          inWindow(run.queue?.providerProcessStartedAt) ||
          (inWindow(run.queue?.claimedAt) && !providerStarted(run)),
      );
      gauge('provider_starts_window', started.length, { pipeline });
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
      const finished = terminal.filter((run) => run.state === 'finished');
      const completedDeliveries = finished.filter((run) =>
        completedPullRequestDelivery(run, now),
      );
      for (const stage of [
        'admission_to_queue',
        'queue_to_claim',
        'claim_to_provider_start',
        'admission_to_completed_pr_delivery',
      ] as const) {
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
            : stage === 'queue_to_claim'
              ? claimed
              : stage === 'claim_to_provider_start'
                ? providerStartCandidates
                : finished;
        const durations: number[] = [];
        for (const run of candidates) {
          const dispatched = run.events.find(
            (event) => event.by === 'dispatch',
          )?.at;
          const start =
            stage === 'admission_to_queue' ||
            stage === 'admission_to_completed_pr_delivery'
              ? run.createdAt
              : stage === 'queue_to_claim'
                ? dispatched
                : run.queue?.claimedAt;
          const end =
            stage === 'admission_to_queue'
              ? dispatched
              : stage === 'queue_to_claim'
                ? run.queue?.claimedAt
                : stage === 'claim_to_provider_start'
                  ? run.queue?.providerProcessStartedAt
                  : run.delivery?.observedAt;
          const seconds =
            start === undefined || end === undefined
              ? NaN
              : (Date.parse(end) - Date.parse(start)) / 1_000;
          if (
            Number.isFinite(seconds) &&
            seconds >= 0 &&
            (stage !== 'claim_to_provider_start' || providerStarted(run)) &&
            (stage !== 'admission_to_completed_pr_delivery' ||
              completedPullRequestDelivery(run, now))
          )
            durations.push(seconds);
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
      gauge('completed_pr_delivery_window', completedDeliveries.length, {
        pipeline,
      });
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
      // Only the authenticated server spawn clock proves provider start.
      // Claims/heartbeats/result.ok are not spawn, evidence, merge or cost.
      // Only this finished cohort's trusted completed PR bindings remove
      // useful-outcome unknowns; unsupported deliverable kinds stay unknown.
      for (const [measurement, count] of [
        [
          'provider_start',
          providerStartCandidates.filter((run) => !providerStarted(run)).length,
        ],
        ['verified_evidence', finished.length],
        ['useful_outcome', finished.length - completedDeliveries.length],
        ['operational_intervention', terminal.length - interventions.length],
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
    for (const kind of [
      'dispatch-run',
      'report-outcome',
      'monitor-delivery',
    ] as const) {
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
