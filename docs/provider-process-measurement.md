# Provider process start measurement

This is the provider-process event contract for fleet FL-OB-5 / #2200.
The broader lifecycle snapshot and Homelab recording/alert handoff are tracked
in PR #2330. This additive event does not qualify the fleet's proposed SLOs.

## Events and clocks

| Event                     | Durable source                       | Meaning                                                                                                                       |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Admission                 | `Run.createdAt`                      | Server accepted a unique attempt. Duplicate admission requests refer to that same run.                                        |
| Queued                    | dispatch event with `by: dispatch`   | Dispatch outbox made the attempt queueable. `state: running` can still be queued.                                             |
| Claim                     | `Run.queue.claimedAt`                | Executor claimed the attempt, before bootstrap and credential waits.                                                          |
| Worker liveness           | `Run.queue.firstHeartbeatAt`         | First accepted worker heartbeat, including bootstrap.                                                                         |
| Provider process observed | `Run.queue.providerProcessStartedAt` | Server accepted the current run token's report after Node's successful OS `spawn` event for the provider workload executable. |

All durable clocks are server UTC observation times. The process observer is
inside the existing workload timeout, after bootstrap/credential restore, and
wraps Claude's print workload, Codex's exec workload and OpenCode's run workload.
Session listing, import, credential waits and telemetry setup do not report it.
An executable can spawn and then immediately reject authentication or quota;
this event proves neither a model request nor first useful token. The metric's
name and dashboards must say **provider process observed**, not model launch.

The reporter uses the existing run-token heartbeat route with the optional
literal `providerProcessStarted: true`. A normal heartbeat never sets the
field. The existing atomic Task+Run transition checks current claim fingerprint,
active ownership and recovery deadlines; unauthorized, stale, expired or
terminal attempts cannot add the observation. The first accepted timestamp
wins, including repeated correction rounds and duplicate/concurrent callbacks.
A new execution retry has a fresh run identity and no inherited observation.
No migration or historical backfill is valid.

The reporter sends its bearer through curl stdin, with no credential in argv
or output. Transport is best effort and bounded to five seconds (six-second
process kill backstop). It does not delay provider execution or extend workload lifetime. The supervisor
cancels an unfinished callback when the workload exits; short-lived workloads
can therefore remain unknown even when reporting transport is otherwise healthy. It preserves workload
stdio, numeric exit status and signal termination under the original timeout.
Failed OS exec never emits an event. A failed report leaves the observation
unknown even if the provider did run; no process-local counter stands in for it.

## Operator measurement handoff

The read-only Work item views expose `claimedAt`, `firstHeartbeatAt` and
`providerProcessStartedAt` beside queue state. They omit missing clocks rather
than serializing a zero or extrapolating from `updatedAt`, result or telemetry.
The authoritative retained Run also contains these same optional clocks.
The lifecycle collector must join by immutable `runId`, deduplicate that identity,
and aggregate with only a fixed provider allowlist plus `other`; never export
run IDs, repository, anchor, session, runner, token or error text as labels.

For a complete admission cohort `[windowStart, windowEnd)`:

- Denominator: unique admitted Run identities with `createdAt` in the window,
  including automatic retries as distinct attempts. Also publish a separate
  retry count using `requestSource: auto-retry`; do not collapse retries into
  successful tasks.
- Observed count: cohort runs with a valid provider-process observation at or
  after admission and, when known, claim. Unknown count: all others. Missing
  timestamps include old workers and failed transport; they are not evidence
  of a launch failure. Future/reversed timestamps are unknown clock data.
- Admission-to-process and claim-to-process samples: differences between those
  exact known clocks in seconds. Never substitute admission-to-running or
  first heartbeat. The observation includes callback transport latency. Omit
  an unavailable sample and publish its unknown count; never clamp it to zero.
- Terminal classification is independent: parks/no-ops can have a known
  process observation; provider-limit can too. A lost run retains an earlier
  observation. Raw `result.ok` is not usefulness, and a known spawn is not
  evidence. Neither is a denominator for useful-deliverable or cost SLOs.

Use nonoverlapping admission cohorts for durable event counts, or explicitly
named rolling **gauges** for bounded snapshots. A truncated recent-run feed
cannot establish a complete cohort; do not publish its quantiles as healthy.
Require complete/fresh collection, zero unknown clocks in the qualified cohort,
and at least 20 observed samples before comparing a five-minute or one-hour
p95 with a target. Display unknown coverage even when the alert is suppressed.
Keep capacity/cooldown time in unconditional latency; an availability-conditioned
claim target needs a separate durable capacity/cooldown join.

Homelab owns collection installation and production recording/alert configuration.
This change creates no credentials, index, Terraform resource, scrape job,
Prometheus configuration or deployment. Extend the lifecycle template's freshness,
completeness and sample gates only once its collector consumes this event.
A model-start/first-token SLO, independently verified useful outcome, human-touch
and actual billing joins, and real elapsed SLO qualification remain separate
acceptance gates on #2200; absence must remain unknown.
