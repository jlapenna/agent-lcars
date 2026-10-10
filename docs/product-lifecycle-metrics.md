# Product lifecycle observations

This is the measurement contract and operator handoff for FL-OB-5 / issue
#2200. It does not install monitoring or declare proposed SLOs achieved.
Homelab owns collection, Prometheus/Alertmanager configuration and paging.

## Read boundary

`GET /api/work/v1/metrics/lifecycle` requires an existing `work.operator`
or `work.cron` principal. Executor-only/reaper-only identities cannot read it.
It returns `observedAt`, `windowSeconds: 3600`, `complete`, and Prometheus
text in `prometheus`. `work metrics` prints that text; `work metrics --json`
prints the complete response. Both are read-only and never drain, sweep,
claim, renew, dispatch, or repair a run.

The store makes three bounded queries: runs updated during the last hour,
all live runs, and outstanding pending/leased/failed outbox entries. Each
reads at most 1001 documents using automatic single-field indexes. Any feed
over 1000 makes `complete=false`; only completeness, observation time and
read-size diagnostics are emitted. CLI exit is then nonzero, but its stdout
still contains the incomplete-observation signal. Errors return generic 500,
not partial healthy metrics. No migration, backfill, new index, or data write
is required.

These are independently read durable feeds, not one atomic Firestore
snapshot. Records with the same run ID are deduplicated, choosing the newest
observed revision. A transition racing the queries can appear in the next
observation. Repeated HTTP exports, duplicate webhooks and idempotency
replays do not increment counts; automatic retries are distinct generations.

## Events, clocks and denominators

All exported values are **gauges**, including cumulative latency buckets.
The inclusive rolling hour is `[observedAt-3600s, observedAt]`; old live
runs and dead letters remain in stock measures. Never use `rate()` or
`increase()` on these rolling counts, sum overlapping windows, or sum
collector replicas. Choose one logical collector per fleet; retain its
job/instance labels. Only the four pipeline labels `claude`, `codex`,
`opencode`, `unknown` are possible. No repo, task/run/request ID, principal,
error prose, token, URL, or monetary estimate becomes a metric label.

Every metric has HELP metadata and gauge TYPE metadata. Latency uses
`latency_window_samples{upper_bound_seconds="60"}` (and 120/300/900/3600/+Inf),
`latency_window_observations`, and `latency_window_duration_seconds` instead
of reserved histogram `_bucket`/`le`/`_count`/`_sum` names. These are rolling
distributions, not Prometheus histograms; do not apply `histogram_quantile()`
directly. The admission warning compares the bounded samples with the
observation denominator. Check a live export with `promtool check metrics`.

All names below have prefix `lcars_product_`.

| Measurement                                    | Exact event/clock and interpretation                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admitted_window`, `auto_retries_window`       | One Run identity with `createdAt` in the hour; retries additionally require durable `requestSource=auto-retry`. This is admitted generations, not received webhooks, unique tasks or launched agents.                                                                                                                                                  |
| `claims_window`                                | Retained `queue.claimedAt` in the hour. Releasing/reclaiming a reservation erases/replaces that field; this is not an all-time claim-attempt counter.                                                                                                                                                                                                  |
| `latency_window_*`, stage `admission_to_queue` | Run `createdAt` to the first durable `by=dispatch` event; included when that dispatch event is in the hour. This queue-confirmation observation excludes webhook transport delay and does not prove worker launch.                                                                                                                                     |
| `latency_window_*`, stage `queue_to_claim`     | First durable dispatch event to retained `claimedAt`; included when claim is in the hour. Includes cooldown, deferral and capacity waits. The record does not retain a capacity-eligible clock, so this cannot prove the proposed capacity-conditional claim SLO.                                                                                      |
| Latency count/sum/buckets/unknown              | Known finite nonnegative durations contribute one sample to count/sum and cumulative buckets 60/120/300/900/3600/+Inf seconds. Missing or reversed clocks contribute to unknown, never zero latency. Quantiles are estimates over known durations only.                                                                                                |
| `settled_window`                               | Finished/canceled/lost runs whose last event into their current terminal state is in the hour; no heartbeat `updatedAt` substitution. `terminal_clock_unknown_window` counts recently updated terminal records missing that clock.                                                                                                                     |
| `reported_outcome_window`                      | Finished-window denominator, split by reported summary: pull-request, merged-deliverable, comment, review, park, no-op, provider-limit, runner-failed, agent-failed, no-deliverable, unknown-success, other/missing. `ok=true` is never called useful work; park/no-op stay separate. These are worker reports, not independent artifact verification. |
| `live_runs`, `oldest_queued_seconds`           | All observed live records split into queued/claimed/unclassified; oldest queued age is since Run admission (`createdAt`), including pre-queue time. Running state alone does not mean claimed or executing.                                                                                                                                            |
| `silent_loss_runs`                             | Live, non-queued runs with lease expiry more than the five-minute maintenance interval before observation. Queued capacity waits are excluded because their execution leases do not expire. This is an overdue-recovery signal, not proof a provider is silently dead.                                                                                 |
| `outbox_entries`, `outbox_oldest_seconds`      | All outstanding entries split by bounded kind/state, including old failed dead letters. Age is since entry creation; done entries are excluded.                                                                                                                                                                                                        |
| `outbox_recorded_delivery_failures`            | Sum of persisted `deliveryFailures` on outstanding entries, not outbox `attempts`. Claims and expired drain-lease recoveries alone contribute zero. Settlement/removal can decrease this stock gauge.                                                                                                                                                  |

`measurement_unknown_window` deliberately describes the unsupported facts:

- `provider_start`: denominator retained claims in the hour. Neither a claim,
  Kubernetes Job creation, a bootstrap heartbeat, nor `running` proves the
  provider began. The [provider-process contract](provider-process-measurement.md)
  now retains `Run.queue.providerProcessStartedAt`, a server observation of
  successful OS spawn bound to the run/claim identity. This snapshot does not
  yet consume that clock; its `provider_start` series remains unknown. OS spawn
  is not authentication, model execution, or independently verified usefulness.
- `verified_evidence`: denominator finished runs in the hour. The ledger has
  a reported outcome but not the artifact verifier result/version/exact
  attempt marker and its durable verification time. Parks and no-ops require
  their own verified classifications, not useful-deliverable credit.
- `useful_outcome`: same denominator. It needs independently verified
  deliverable kind and usefulness/merge evidence. A PR-shaped ref or an
  agent's `merged-deliverable` summary is not a GitHub merge fact.
- `human_touch`: denominator terminal runs, explicitly **not** a unique-task
  rate. A real task-level rate must deduplicate task identity over an
  admission cohort, correlate immutable verified park/manual-action events
  to eventual merge, and retain unresolved/censored tasks as unknown. A
  reported park alone is only a reported handoff, not all human activity.
- `cost`: denominator finished runs. Real cost-per-merged-deliverable needs
  exact attempt-to-session billing joins (all retries/parks included), actual
  currency/price basis and independently verified distinct merged PRs. Missing
  subscription/local-inference prices and unmatched sessions remain unknown,
  not zero-dollar or token-derived claims.

Webhook-receipt admission latency, console time-to-decision, degradation
rate, phone decision reach and end-to-end traceability also remain unknown:
they need their own durable receipt/decision/render/identity joins. This PR
does not turn process-local executor launch counters into those facts.

## Testable monitoring handoff

The reviewed, unapplied template and deterministic rule tests live in
`tools/observability/product-slo.rules.yml` and
`tools/observability/product-slo.rules.test.yml`. Use an approved Prometheus
`promtool` to run:

```sh
promtool check rules tools/observability/product-slo.rules.yml
promtool test rules tools/observability/product-slo.rules.test.yml
```

The collector should poll once a minute using an existing approved identity,
extract the `prometheus` field without changing its values, and publish it
to a single logical scrape target. Incomplete snapshots must be published
even though the CLI exits nonzero; retaining the last good file hides a
current truncation. On HTTP/auth/network failure, remove/invalidate stale
output so missing/stale-data alerts can fire. Collection credentials, an
exporter/textfile collector service, its timeout, and alert installation are
Homelab's reviewed handoff, not operations performed by this repository.

The template gates operational alerts on a complete observation younger than
three minutes. Missing/incomplete/stale collection warns after ten minutes;
silent-loss and dead-letter stocks warn after ten minutes of valid data.
Admission's proposed 95% within **60 seconds inclusive** budget uses at
least 30 known samples in one hour and zero unknown duration samples, then
warns at a bad fraction above 5% sustained fifteen minutes. This is a
low-volume operational warning, not a certified 30-day SLO burn-rate page.
The queue-delay distribution is diagnostic only: the conditional eligibility
clock is missing and capacity waits must not be attributed to launch latency.

After durable trustworthy events and longitudinal data exist, the suggested
30-day SLO handoff is a reviewed dual-window budget burn: fast 14.4x on both
1h/5m and slow 6x on both 6h/30m, with minimum-volume and unknown-data gates.
The current overlapping 1h gauges cannot implement those independent windows;
the template deliberately does not pretend to do so. Keep #2200 open for
those event joins, collection installation and real elapsed qualification.
Prometheus owns the [rule-test format](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)
and [alert `for` semantics](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/).
