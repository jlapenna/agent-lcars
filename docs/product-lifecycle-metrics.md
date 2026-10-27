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

| Measurement                                                    | Exact event/clock and interpretation                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admitted_window`, `auto_retries_window`                       | One Run identity with `createdAt` in the hour; retries additionally require durable `requestSource=auto-retry`. This is admitted generations, not received webhooks, unique tasks or launched agents.                                                                                                                                                                                                  |
| `claims_window`                                                | Retained `queue.claimedAt` in the hour. Releasing/reclaiming a reservation erases/replaces that field; this is not an all-time claim-attempt counter.                                                                                                                                                                                                                                                  |
| `latency_window_*`, stage `admission_to_queue`                 | Run `createdAt` to the first durable `by=dispatch` event; included when that dispatch event is in the hour. This queue-confirmation observation excludes webhook transport delay and does not prove worker launch.                                                                                                                                                                                     |
| `latency_window_*`, stage `queue_to_claim`                     | First durable dispatch event to retained `claimedAt`; included when claim is in the hour. Includes cooldown, deferral and capacity waits. The record does not retain a capacity-eligible clock, so this cannot prove the proposed capacity-conditional claim SLO.                                                                                                                                      |
| `latency_window_*`, stage `admission_to_completed_pr_delivery` | Run `createdAt` to its trusted final complete `delivery.observedAt`, using the same finished-hour cohort and qualification as `completed_pr_delivery_window`. This is admission-to-observed-completion of a PR-delivery attempt, not GitHub merge time, artifact creation time, or universal usefulness. Every unqualified finished cohort member contributes one unknown, not a zero-duration sample. |
| Latency count/sum/buckets/unknown                              | Known finite nonnegative durations contribute one sample to count/sum and cumulative buckets 60/120/300/900/3600/+Inf seconds. Missing or reversed clocks contribute to unknown, never zero latency. Quantiles are estimates over known durations only.                                                                                                                                                |
| `settled_window`                                               | Finished/canceled/lost runs whose last event into their current terminal state is in the hour; no heartbeat `updatedAt` substitution. `terminal_clock_unknown_window` counts recently updated terminal records missing that clock.                                                                                                                                                                     |
| `reported_outcome_window`                                      | Finished-window denominator, split by reported summary: pull-request, merged-deliverable, comment, review, park, no-op, report, provider-limit, provider-capacity, runner-failed, agent-failed, no-deliverable, unknown-success, other/missing. `ok=true` is never called useful work; park/no-op stay separate. These are worker reports, not independent artifact verification.                      |
| `completed_pr_delivery_window`                                 | Subset of the same finished-hour Run cohort with trusted completed protected PR delivery. Each binding must identify this exact Run, contain valid head/merge identity and an admission-or-later server observation no later than the Run revision or snapshot. This counts completed PR-delivery attempts, not distinct PRs, all useful artifact kinds, or delivery observations in the hour.         |
| `live_runs`, `oldest_queued_seconds`                           | All observed live records split into queued/claimed/unclassified; oldest queued age is since Run admission (`createdAt`), including pre-queue time. Running state alone does not mean claimed or executing.                                                                                                                                                                                            |
| `silent_loss_runs`                                             | Live, non-queued runs with lease expiry more than the five-minute maintenance interval before observation. Queued capacity waits are excluded because their execution leases do not expire. This is an overdue-recovery signal, not proof a provider is silently dead.                                                                                                                                 |
| `outbox_entries`, `outbox_oldest_seconds`                      | All outstanding entries split by bounded kind/state, including old failed dead letters. Age is since entry creation; done entries are excluded.                                                                                                                                                                                                                                                        |
| `outbox_recorded_delivery_failures`                            | Sum of persisted `deliveryFailures` on outstanding entries, not outbox `attempts`. Claims and expired drain-lease recoveries alone contribute zero. Settlement/removal can decrease this stock gauge.                                                                                                                                                                                                  |

Completed PR delivery is read from `Run.delivery`, authored by the server's
exact-attempt handoff verifier and the delivery state machine. The worker's
`ok`, summary or PR-shaped reference cannot establish this fact. A successful
finished Run with a valid complete binding earns one sample; waiting bindings,
mismatched Run identity, missing merge identity and malformed/future/reversed
clocks remain unknown. Inconsistent park/no-op/review reports receive no credit.

The cohort clock remains the last durable finished event. A delivery completed
after its Run's settlement leaves the rolling hour does not enter this metric
through its recent `updatedAt`. It is not a complete journal of delivery events.
The admission-to-completed-PR-delivery latency uses this same cohort. Its end
clock is the retained final authorized binding observation, not a worker report,
PR timestamp or exporter read time. It includes review/check/runtime waits up to
that observation; delayed verification can therefore exceed actual merge time.
The bucket/count/sum distribution describes qualified attempts only, while its
unknown count includes all other finished cohort members. It is diagnostic:
no new SLO target or success claim follows from adding this duration.

Protected landing can already be established before execution settlement, so
the observation need not follow the finished event. Duplicate feeds/exports
credit one Run using its newest observed revision; retries remain separate Run
identities, even if they concern the same PR. No task-level success ratio or
cost-per-distinct-merge denominator is derived from this subset.

`operational_interventions_window{kind="work-api-cancel"}` counts a narrow,
positive operational-intervention fact in the same settled-hour Run cohort.
Only the authenticated `work.operator` Work API live-cancel handler stamps
`RunEvent.intervention` with this kind and its verified principal, atomically
with cancellation. The terminal event must be `by=operator`, and admission,
settlement, Run revision and snapshot clocks must be valid and ordered.
Duplicate feeds and repeated reads count one newest Run identity; retry
generations remain distinct. No caller body, worker parameter, note, username
or authentication method supplies this fact. Automated anchor closure and
provider replacement call the same cancellation primitive without this stamp
and receive no credit. Closing an already parked task settles no Run and is
outside this subset. No historical record is backfilled.

`measurement_unknown_window{measurement="operational_intervention"}` is the
settled-hour cohort minus these qualified members. Absence of a stamp is
unknown, never proof of no intervention. Invalid/missing terminal clocks retain
the separate `terminal_clock_unknown_window` diagnostic. Principal values stay
in the durable record and never become metric labels. An authorized API caller
can itself be automation: this observation does not reduce `human_touch`
unknowns, establish a human identity, deduplicate unique tasks or correlate
interventions with eventual merge. It provides one trusted producer for that
future task-level join; no human-touch rate or target is claimed.

`reply_interventions_window` counts admitted-hour Run identities whose first
pending/request event contains the typed `work-api-reply` action. Only the
authenticated `work.operator` reply handler supplies its verified principal to
the admission transaction. The event clock must exactly equal admission;
revision and snapshot clocks must be valid and ordered, and request source must
be `caller`. Raw reply params, channel, supplied principal text and initial
admission cannot manufacture the stamp. Other reply ingresses, legacy records
and automatic retries remain unknown. Replayed request keys return the original
Run without another admission; separate accepted replies count separate Run
generations, even for the same task. Provider selection inside this API reply
is included once with its newly admitted generation, not also credited as a
cancellation of the replaced generation.

`measurement_unknown_window{measurement="reply_intervention"}` is the
admitted-hour cohort minus qualified API replies. This cohort differs from the
settled-hour cancellation cohort; neither family changes `human_touch`
unknowns. No human identity, unique-task rate, successful outcome or eventual
merge follows from an authorized reply. Principal values never become labels.

`admitted_tasks_window` counts distinct canonical task identities with at least
one Run `createdAt` in the inclusive rolling-hour window. This is an admitted
attempt cohort: it includes retries and replies for older tasks, not just
first-ever task creation. One task counts once across automatic retries,
provider generations and duplicate feeds, using the newest observed revision of
each Run. It is global rather than split by pipeline, so provider switching
does not duplicate the denominator. No task identity is exported as a label.

`redispatch_interventions_window` counts admitted-hour Run identities created by
the authenticated native Work item's redispatch route. That handler stamps
`work-api-redispatch` with its verified principal on the first request/pending
event, atomically with admission. The same clock and provenance checks as reply
admissions apply. Initial creation, automatic retries, GitHub-anchor redispatch
and caller-supplied params receive no credit. A repeat while the generation is
live is refused and adds no admission; a later accepted redispatch after another
park/failure is a separate generation. The corresponding
`measurement_unknown_window{measurement="redispatch_intervention"}` is the
admitted-hour Run cohort minus qualified native redispatches. Authorized callers
can be automation, so this does not establish human identity or useful work.

`intervened_tasks_window{kind="work-api-reply"|"work-api-cancel"|"work-api-redispatch"}` counts those
cohort tasks with the corresponding qualified durable action on an admitted
Run, using the same exact event/provenance/clock checks as the Run families
above. `kind="any"` is the distinct union, not a sum: a task with multiple actions
counts once. Cancellation of a Run admitted before the hour is excluded from
this cohort even when cancellation occurs in the hour; the existing settled-hour
Run cancellation family still includes it. Actions on generations admitted before this window do not supply credit to
a newly admitted retry of the same task.

`task_intervention_unknown_window` is the admitted task denominator minus that
qualified union. A missing or invalid stamp supplies unknown history, never an
untouched or human-free classification. The positive union plus unknown equals
the distinct cohort size. This is observed API-intervention incidence, not a
human-touch rate: verified principals can be automation, other action producers
and earlier history remain incomplete, and no eventual merge join is supplied.
An incomplete bounded snapshot exports none of these task gauges. Repeated
scrapes cannot add tasks; do not apply `rate`/`increase` to these rolling gauges.

The fuller intervention join remains a product goal. These existing owners
provide the next action boundaries; none alone proves a biological human:

| Action boundary                                         | Existing durable fact and remaining join                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live Work API cancel (`work-router.ts`, `cancelRun`)    | This typed cancellation event now proves authorized API intervention; parked-item close only has `Task.closedAt` and still needs a typed action fact.                                                                                                              |
| Reply / provider selection (`work-reply.ts`, `request`) | Work API replies now stamp the first admission event with typed action provenance; other channels retain only opaque params. Admitted-task incidence is now deduplicated; full-history/eventual-merge joins remain absent, and automatic retries receive no stamp. |
| Explicit redispatch (`work-router.ts`, `request`)       | Native Work API redispatch now stamps typed provenance and joins the admitted task cohort. GitHub-anchor redispatch and other ingresses remain unknown; `requestSource=caller` alone cannot prove intervention.                                                    |
| GitHub label/provider/manual action owners              | Signed webhook actor/clock and provider-routing acceptance exist; accepted action provenance must survive in the task cohort without interpreting a login as human.                                                                                                |
| Runtime evidence (`work-router.ts`, `advanceDelivery`)  | Exact Run/head/merge binding retains authorized attestation principal and clock; it must join to the same task cohort, while independent content verification remains a separate fact.                                                                             |

A complete task-level rate still needs a unique admitted-task cohort across
retry/provider generations, explicit typed action coverage, eventual trusted
merge identity, and unresolved/censored outcomes. Missing action history or
unknown human identity cannot become a zero-touch task. This producer step
supplies no task-level rate, broad artifact classification, monitoring install
or SLO-attainment claim. These explicit unknowns are part of #2200's measurement
contract; the broader product goals do not become measured facts by inference.

`measurement_unknown_window` deliberately retains unavailable facts:

- `provider_start`: observations without a valid retained server spawn clock.
  Candidates are spawn clocks in the hour, plus retained claims in the hour
  whose spawn is unobserved or invalid. Missing/reversed claim clocks, invalid
  admission clocks, and spawn clocks before admission or after observation stay
  unknown. Neither a claim, Kubernetes Job, heartbeat nor
  `running` supplies a start. `provider_starts_window` counts valid retained
  `Run.queue.providerProcessStartedAt` observations in the hour, including
  starts whose claim predates that window; `claim_to_provider_start` measures
  their claim-to-observed-spawn delay. These are authenticated, identity-bound
  server observations of successful OS spawn, not authentication, model
  execution or independently verified usefulness. Release/reclaim can replace
  the retained claim; these gauges are not a complete historical event journal.
- `verified_evidence`: denominator finished runs in the hour. The ledger has
  a reported outcome but not the artifact verifier result/version/exact
  attempt marker and its durable verification time. Parks and no-ops require
  their own verified classifications, not useful-deliverable credit.
- `useful_outcome`: finished-hour denominator minus qualified completed PR
  delivery members of that same cohort. Other artifact kinds remain unknown;
  no negative usefulness conclusion follows from a missing binding. This
  narrow completed-delivery observation does not establish semantic quality
  for every artifact. A PR-shaped ref or an agent's `merged-deliverable`
  summary is not a GitHub merge fact.
- `human_touch`: denominator terminal runs, explicitly **not** a unique-task
  rate. A real task-level rate must deduplicate task identity over an
  admission cohort, correlate immutable verified park/manual-action events
  to eventual merge, and retain unresolved/censored tasks as unknown. A
  reported park alone is only a reported handoff, not all human activity.
- `cost`: denominator finished runs. This series retains unknown Work-attempt
  billing because exact attempt-to-session invoice joins are absent. The
  separate canonical session-cost proxy below supplies reported/estimated
  session cost per known distinct merge, with explicit cohort and coverage;
  it does not claim an invoice join. Missing subscription/local-inference
  prices and unmatched sessions remain unknown, not zero-dollar claims.

Webhook-receipt admission latency, console time-to-decision, degradation
rate, phone decision reach and end-to-end traceability also remain unknown:
they need their own durable receipt/decision/render/identity joins. This PR
does not turn process-local executor launch counters into those facts.

## Session cost proxy

The same authenticated export appends `lcars_product_session_cost_*` gauges
from the canonical Costs `SessionSpend` owner. It selects sessions with recorded
activity in the rolling hour ending at `observedAt`, retains at most 200 newest
sessions, and uses existing stored GitHub PR projections (at most 200 point
reads, eight concurrent, five-second shared projection deadline). The session
reader streams matching recent records with bounded retained memory; 200 is the
returned-page bound, not a promise of 200 underlying document reads. This is a
read-only, nontransactional snapshot. Future/invalid activity clocks are excluded
and make coverage partial. Page saturation also makes coverage partial.

`session_cost_reported_usd` and `session_cost_estimated_usd` remain separate.
Both are **whole cumulative session costs**, not charges incurred during that
hour or actual invoice amounts. All selected sessions contribute, including
retries, failed attempts and sessions without PRs. The denominator is distinct
repository-qualified, known-merged PRs referenced by that same selected cohort,
regardless of merge date. The canonical stored-evidence attribution rules apply;
worker claims and unqualified PR numbers never establish a merge. A PR shared
by multiple selected sessions counts once within each pipeline; pipeline PR
counts must not be summed to obtain a globally unique denominator.

Only `claude`, `codex`, `opencode` and `unknown` pipeline labels are exported.
Other adapters fold into `unknown` before canonical PR deduplication. No session,
model, repository, principal, URL or error labels are exported. The existing
Costs page retains its adapter-specific grouping.

`session_cost_read_available=0` suppresses money/cohort samples when the feed
fails or aggregates are nonfinite. `session_cost_read_complete=0` marks a capped
or degraded archive/projection read. Those gauges are independent of the
existing three-durable-feed `snapshot_complete`; cost uncertainty does not hide
live-run or dead-letter health. Unpriced sessions, unknown PR statuses and
unqualified reference counts remain explicit. The cost-per-merged-PR proxy is
omitted if no price or known merge exists; otherwise `coverage=partial` marks
any missing price, attribution or read coverage. Reported zero is distinct from
unknown pricing. Do not sum successive rolling-window gauges or treat this
proxy as actual task/run billing.

The source cost proxy retains unknown prices and attribution explicitly, as
required by #2200's measurement contract. Universal artifact verification,
human identity and exact invoice joins remain broader product goals. The
operator recording-rule/alert handoff is a source deliverable; installation
and elapsed SLO qualification remain separate Homelab operational work.
