# Agent dispatch: operational ownership

Use this document to identify the owning system when an agent dispatch fails.
It describes the current orchestrator; historical dispatch implementations are
available through Git history.

## Ownership

| System          | Owns                                                                          | Source                                                           |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Orchestrator    | Per-task admission, leases, dispatch/outcome outbox, and reconciliation.      | `libs/orchestrator/`, `apps/console/src/lib/orchestrator-*.ts`   |
| Runner platform | Direct-runner launch capacity, host readiness preflight, and loss recovery.   | `apps/runner-autoscaler/`; live configuration belongs to Homelab |
| Worker runtime  | Bootstrap, agent invocation, credential separation, and deliverable evidence. | QueueExecutor direct-runner image and native runtime helpers     |

## Dispatch contract

1. A webhook request creates a task-scoped run only when no live run exists.
   Duplicate or concurrent requests are refused rather than queued.
2. The orchestrator records the decision atomically and enqueues a
   `dispatch-run` outbox entry. The outbox writes the run to QueueExecutor's
   claimable queue state; it does not dispatch a GitHub Actions workflow.
3. The QueueExecutor claims that identity, runs the direct-runner bootstrap,
   then reports completion through the Work API run-token route.
4. A successful worker run must satisfy the native deliverable verifier: an artifact
   contains its exact `<!-- attempt-claim:<attempt-id> -->` marker.
5. A lease is renewed while the run is live. When a worker terminates
   without reporting, the QueueExecutor reports the exit and the run is
   settled `lost` at once; reconciliation settles expired leases as the
   backstop. Claims that never deliver a first heartbeat have a separate
   fifteen-minute startup deadline (normally settled within twenty minutes
   by the five-minute maintenance tick), followed by the same bounded retry.
   Normal executor recovery retires the exact settled claim's original Job
   with guarded foreground deletion; admission waits for its owned Pods to
   drain. Expiry alone is not deletion authority. Both perform bounded retry; an exhausted retry budget parks the
   task for manual action.

## Authorized label provider handoff

A sole `agent:*` replacement from the Console administrator allowlist uses
`github-work-admission.ts` and the authoritative request transaction. Its signed
source clock must advance past the latest label request. The transaction reads
the active attempt, latest attempt and retained physical claims before deciding.
It cancels only unclaimed queued work and mints one fresh requested-provider
attempt; Work and predecessor provider facts remain unchanged. Claimed/running
owners and unresolved credential operations refuse. A
settled claim whose credential cleanup has finished retains nothing physical,
so a later label may route it; a restore receipt alone never fences. Parked and
terminal tasks may start fresh only with those gates clear. Refused requests are
visible in task history; they never become automatic deferred execution, so the
next label application decides afresh once the gate that refused has cleared.
Ordinary provider claim and capacity fences still apply to the successor.

## Worker startup acknowledgement

The direct-runner installs its best-effort EXIT failure reporter after reading
its authenticated brief, then synchronously sends one ordinary heartbeat before
checkout, credential restoration, telemetry startup or provider execution. It
requires HTTP 200 and one JSON object containing the exact `runId` and a valid
UTC `expiresAt`. Refusal, transport failure or an unknown acknowledgement stops
setup without retrying into provider work. The Console returns this existing
response only after authenticated renewal commits. Its original startup deadline
and exact claim/credential authority remain authoritative; a successful brief
read alone does not establish completion authority.

After acknowledgement the existing periodic heartbeat loop maintains liveness
through setup, credential contention and execution. Bootstrap liveness does not
report OS process spawn: the separate provider-process supervisor owns that
observation, and neither observation proves model activity or useful results.
Provider execution/correction budgets retain their existing monotonic clocks.

| Producer / reader                                                                          | Startup behavior                                                                                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Acknowledgement-gated worker / Console returning the existing committed heartbeat response | Setup proceeds only after accepted startup, including placement with less than one periodic interval remaining. |
| Acknowledgement-gated worker / missing route, refused or malformed response                | Stops before checkout, credential restoration or provider work.                                                 |
| Older worker without this gate / startup-fenced Console                                    | No retroactive protection; a periodic first heartbeat arriving after the startup deadline is still refused.     |

This gate does not attest an image before claim. Runner identity alone does not
prove compatibility; exact image/source adoption and a genuine delayed-start
attempt with terminal credential persistence/completion remain separate runtime
qualification gates. A refused EXIT callback cannot prove durable settlement.
Existing authenticated executor exit, deadline recovery, credential cleanup and
positive physical retirement own recovery; published artifacts do not authorize
reviving an expired worker or releasing its claim.

## Explicit provider fallback

Fallback is opt in: Work `spec.fallbackPipelines` names ordered alternatives;
reply and redispatch may override the list for one request (`[]` disables it).
Omission preserves the existing provider and label selection. New work's picker
and `lcars work create/redispatch --fallback-pipelines codex,opencode` expose the
same contract; `--fallback-pipelines none` disables an inherited list. GitHub
pull-request review runs admitted through `pr-review-routing.ts` populate
`spec.fallbackPipelines` automatically under principal `svc:github-pr-review`
([automatic PR remediation](#automatic-pr-remediation) does the same under
`svc:github-pr-remediation`; listed before the author fallback is appended: `codex` PR -> `claude` with
`['agy']`; `claude` PR -> `codex` with `['agy']`;
`agy` PR -> `claude` with `['codex']`, or `codex` with `['claude']` when
`review:codex` is requested; `opencode`/human PR -> `claude` with
`['codex', 'agy']`). The selector then appends a recognized authoring
pipeline as the last alternative only when it is supported, differs from the
primary and is not already listed, so an OpenCode-authored review gets
`['codex', 'agy', 'opencode']` and a human-authored one keeps
`['codex', 'agy']`. Admission records the resulting order on
`run.providerFallback.allowedPipelines`. That orders preference only; it does not
guarantee every opposite model was tried first. Fallback prefers the first
alternative that is available now, so when a `claude` review of an `agy` PR
hits its limit while another run holds Codex's exclusive claim, the successor
can go straight to `agy` although Codex never hit a limit
(`selectFallbackPipeline` in `libs/orchestrator/src/provider-fallback.ts`;
live-claim ceilings in `queue-admission-status.ts`).

Admission intersects the list with the authenticated principal's pipeline
grant. A failed `provider-limit` report can atomically settle its attempt,
retain the limited provider's cooldown and mint a fresh authorized successor.
`direct-runner.sh` classifies `provider-limit` from anchored CLI limit banners
at the start of `$AGENT_MESSAGE` (`You've hit your weekly limit`,
`You've hit your usage limit`, `Credit balance is too low`, `You've hit your monthly spend limit`,
`API Error: 4xx` quota errors such as an organization spend cap) and from structured provider failure events in
`$PROVIDER_FAILURES` (Codex stream errors, Codex's own stderr lines that begin with its
`You’ve hit your usage limit` / `weekly limit` banner, and Antigravity's `AGY_ERROR:` stderr
records: `usage_limit_reached`, `insufficient_quota`,
`exceeded your current quota`, `credit balance is too low`,
`monthly spend limit`, `service_spend_limit_reached`, `org_spend_cap_reached`,
`ResourceExhausted`, `RESOURCE_EXHAUSTED`; a typographic `’` matches as `'`), keeping ordinary `report` prose distinct from provider quota stops.
It prefers an available authorized alternative. When all remaining alternatives
are temporarily occupied or cooling down, the first authorized unattempted
alternative remains a fresh queued intent; ordinary claim ceilings and cooldowns
hold it until it can run. Missing opt-in or revoked authority settle without a
successor, as do exhausted alternatives for native Work and non-review runs.

A GitHub PR review (`mode: review`) whose authorized alternatives are all
exhausted by quota or capacity failures backs off instead of failing (#3300),
whether or not a provider reported a reset: the decision mints a
deferred successor on the round's first provider, with
`providerFallback.providerWait` recording the attempt and `retryAt`. The wait
starts at 15 minutes and doubles up to 6 hours, for at most
`MAX_PROVIDER_WAITS` (7) waits, about 20 hours in all; after that the review
settles failed. Each wait starts a fresh fallback round, so a provider tried
before the wait can be selected again. Each wait still requires current authority, the claim fence
still applies the provider's cooldown, and queued-cooldown rerouting can move
the due run to a free alternative. Sources: `waitForProvider` in
`libs/orchestrator/src/provider-fallback.ts` and `MAX_PROVIDER_WAITS` in
`model.ts`; waiting runs are counted by the `provider_wait_runs` lifecycle
gauge.
A `provider-capacity` report is the same availability class with no window to wait on: the direct
runner derives it from the provider's own structured failure events when a round stops before any
final message, so an empty last message cannot degrade it to a generic agent failure. It holds that
provider for exactly one bounded probe and never parses a reset, and it keeps the provider's cause
in the reported message. A cross-provider successor still requires the explicit policy and current
grant above; without them the attempt stays failed and the only change is an honest cause.
The runner submits the saved report body or, for a legacy two-line record, the provider's final
response. A resumed follow-up saves the complete updated answer and changed findings in that body.
The completion message, including a parked question or PR summary, is stored whole. `POST /runs/{runId}/complete` accepts it whole up to `RUN_MESSAGE_MAX_BYTES`
(4 MiB of UTF-8, `libs/dispatch-contracts/src/run-message.ts`); only a message past that bound is
refused, and the direct runner refuses such a report before sending it so the round keeps its
correction. The run document keeps the first 16,384 characters in `result.message`. A longer message
is written before settlement, content-addressed, to `runs/{runId}/message-chunks/{sha256}.{index}`
(at most 512 KiB per document) and named by `result.messageOverflow`; a refused or duplicate
completion therefore cannot replace a settled message. Single-item reads (`GET /items/{id}` and every
route answering one item, the Console item view, Inbox cards, triage publication) return the whole
message. `GET /items` returns the preview with `messageOverflow`, and the outcome webhook stays small:
it carries the preview with `messageTruncated` and the Console link. Runs settled before this
contract have no `messageOverflow` and are read unchanged.
Claimed Codex terminal transitions reserve exact cleanup authority in the same
transaction as the original result, successor and outbox. Completion handlers
reload that reservation under the authenticated claim fingerprint before
retiring its credential lease; they do not reserve a second cleanup operation
from the pre-settlement snapshot. A result accepted during credential IO keeps
its original acceptance time. Exact operation, fingerprint and mutation-sequence
proof settle it through the same fallback owner with current grants and queue
eligibility, even when recovery occurs after the original execution deadline.
The shared `Orchestrator.transactOnRun` boundary also reserves cleanup for
accepted executor exit, operator cancellation and lease/startup expiry
(including `sweepExpired`). It preserves the terminal decision's outcome,
deterministic retry and outbox, with a cleanup identity captured outside the
retryable callback and a timestamp from the accepted decision. Physical
retirement cannot discard the claim while that operation or its restored
credential authority remains unresolved. The exit HTTP handler consumes that
reservation; physical release attempted between settlement and conditional
lease cleanup must still refuse.

Lifecycle `cancelUnclaimedBefore` bypasses this wrapper but refuses claimed
runs in its store transaction. Queued cooldown rerouting similarly requires
an unclaimed run. Neither owns a restored claimed credential lease.
`closeTask` and `updateTaskWork` refuse a live active run and change task
metadata rather than settling it. These distinctions qualify the applicable
terminal cleanup races; they do not establish deployed executor behavior.

Maintenance can similarly replace an exact unclaimed queued attempt blocked by
another run's cooldown; it does not fabricate an execution failure. Each
decision rechecks current operator scope, repository admission, any signed OIDC
repository restriction, provider cooldowns and serialized provider occupancy.
The ordinary queue claim still enforces the executor's grant and provider
ceilings. Rerouting runs in a bounded maintenance batch outside the executor's
claim deadline; deferred, claimed and unavailable work stays untouched. GitHub
admission and redispatch of a run with provider fallback run the same batch
once right after their drain, so a fresh review or remediation whose provider
is already in a provider-reported cooldown moves to its fallback at once
instead of waiting up to five minutes for the next maintenance tick.

Run provenance records the original intent, predecessor, triggering failure
and attempted providers. Within one fallback round, alternatives are tried
deterministically without cycles, and cross-provider successors drop session/transcript resume artifacts
while retaining the human request and context. Work/task/conversation views
and outcome delivery identify fresh fallback attempts. A real provider-limit
journey has completed in production; R7 in the
[fleet orchestration spec](product/fleet-orchestration-product-spec.md#12-gaps-and-roadmap)
records the run history.

## Console acknowledgement and maintenance

A Console merge, issue close, or needs-human label cleanup acknowledges its
GitHub mutation after the authoritative anchor projection refresh completes.
These writes do not require a fleet lease sweep. Work admission still uses its
transactional dispatch outbox; closing an anchor is fenced by the close webhook
and the QueueExecutor claim-time lifecycle check.

The existing `work.cron`-authorized `/api/work/v1/maintenance/tick` owns unrelated
lease expiry and durable outbox retry. A failed or held maintenance pass cannot
delay a successful merge acknowledgement. Pending entries and expired drain
leases remain eligible for the next five-minute tick; no request-lifetime
background promise carries required work.

One tick (`handleReconcile` in `apps/console/src/lib/orchestrator-routes.ts`)
runs, in order:

1. Codex credential-operation recovery.
2. `sweepExpired`: lost leases and startup deadlines, with bounded retry.
3. `rerouteQueued`: queued runs blocked by another run's provider cooldown.
4. One outbox drain of at most 30 entries. The reply's
   `outboxContinuationNeeded` is a count-based hint: it counts only
   dispatched, reported and failed entries, so a drain that spent claim
   slots on other outcomes (such as a handoff-summary admission) can return
   `false` with entries left. Regardless of the flag, later ticks continue
   draining eligible entries in batches of up to 30; a pending entry whose
   retry time is still in the future is skipped until that time.
5. In parallel: one queued summary Work attempt (inbox and handoff summaries),
   repository maintenance (`maintainRepositoryJobs`: job and claw-agent
   catalog refresh plus job schedules), and the job-credential observation.

The tick sets one deadline 45 seconds after it starts, before step 1. Summary
Work and repository maintenance receive that deadline, and the
repository-agent catalog observation, started before step 5, is raced against
it. The job-credential observation is awaited without it, so a slow Firestore
read can hold the response past 45 seconds. Separately, the production ticker
gives the whole request a 60-second HTTP timeout. The catalog observation is attached to the reply as `repositoryAgents` only when it
finishes in time, is valid on the wire and keeps the reply within its 60 KiB
budget; otherwise it is omitted without failing maintenance.

Inbox Web Push delivery runs on the schedule tick instead
(`deliverInboxPush` in `apps/console/src/lib/schedule-router.ts`), after due
schedules are admitted; a delivery failure is logged and does not fail the
tick.

The hermetic Inbox journey keeps a 20-second merge-action allowance, distinct
from #2201's navigation-to-ready phone p95 contract.

## Work state events

When a write changes a native Work item's derived state, the orchestrator
store adds one `agent-event` outbox entry in the same transaction
(`itemStateEventOutbox` in `libs/orchestrator/src/item-state.ts`). Writes that
leave the state unchanged, the write that creates the item, and
GitHub-anchored tasks add none. The drain turns the entry into an
`lcars:work:<workId>` event (`workAgentEvent` in
`libs/work/src/work-agent-events.ts`, which owns the state-to-kind mapping:
`running` is `state`, `parked` is `needs-reply`, and `done`, `failed` and
`canceled` are the terminal `done`) and hands it to `routeAgentEvent`. The
event id is the Work id plus the task revision that made the change, so a
retried entry repeats the same id and the router publishes only the
deliveries that failed. Routing costs one subscription query per state
change. A transition never waits on routing; a routing failure follows the
ordinary outbox backoff and retirement, visible in the `agent-event` series of
the outbox gauges.

## GitHub agent events

GitHub App subscriptions are admitted for configured control-plane repositories.
For other repositories, the existing host delivery agent can opt an interactive
session into a native `gh event listen` PR stream. The console derives that
source from its repository inventory; it exposes `githubStream` on subscription
views so the host restores streams after restart. A successful local registration
requires both stream attachment and an authoritative read after registration.
A default App subscription automatically includes newly produced kinds. Outline
is refused until its producer is available.

The preview source covers `review`, `merged`, `closed`, `reopened`,
`checks-finished`, and `conflict`. Explicit requests for other kinds (including
standalone comments, threads, pushed, behind, and auto-merge) fail rather than
silently strand the caller. Work run tokens cannot opt into or publish a host
source. `POST /events/github` accepts only the verified host identity and routes
only that host's session subscriptions, never another host or native Work.
The console generates the details link. The host rereads GitHub with its existing
`gh` identity; no external text enters a notice and the App's actor policy also
applies to preview events. Derived checks retain the same base-repo head policy as App events;
mergeability is generated by GitHub for the target PR, including fork heads.

Streams are shared by PR on each host. Each attach/reconnect resnapshots because
GitHub does not replay gaps. Reads and failed attachments retry with bounded
backoff; errors stay visible in `lcars_events_agent_github_errors_total` and
`github_sources_failed`. `github_restore_ready=0` means unknown or failed
inventory restore. `github_streams_wanted=0` after successful restore is idle;
`github_streams_open < github_streams_wanted` is disconnected. Snapshot timestamps
are historical observations, not a heartbeat: an idle stream needs no repeated
REST reads. The host stops listeners after the last local subscription ends or
its session ends. Account subscriptions can be reused by other hosts/CLI
consumers, so listeners close without deleting shared remote registrations;
GitHub expires those after 24 hours. Its preview quota/access failures are real
source failures; no fallback identity or extra daemon is created. See the
[GitHub event stream contract](https://docs.github.com/en/integrations/how-tos/using-github-event-streams).

GitHub App deliveries for fleet repositories become `github:pr`,
`github:issue` and `github:run` events for subscribed sessions, after
admission and without affecting it. The webhook routes queue a delivery that
stands for an event as its own Cloud Task, and
`/api/control-plane/webhook/events` routes it with one subscription query per
key and, only for a wanted `checks-finished` or `threads-resolved`, one
GitHub read. See
[`github-app-webhook-events.md`](github-app-webhook-events.md#agent-events-from-webhook-deliveries)
for the path and `apps/console/src/lib/github-agent-events.ts` for the
payload-to-kind mapping and the actor rule per kind.

Base pushes and trusted PR head/base-ref changes also schedule a delayed
mergeability read. Only subscribed PR keys are read, once per PR; a base push
is limited to PRs targeting that branch. Known `conflict`/`behind` outcomes
are routed before unknown or unreadable PRs trigger a durable task retry.
Stable delivery IDs suppress repeats. A bounded `lcars-agent-events` enqueue
failure outcome feeds the repository-owned GCP log alert, because a failed
enqueue never appears in queue backlog telemetry.

## Event-resume for dispatched Work

A dispatched run of native Work that must continue after an outside event
subscribes the Work (`lcars session subscribe` with `LCARS_RUN_ID` and
`LCARS_RUN_TOKEN`, which calls the subscription API with its run token) and
parks with a `Waiting on event:` line (agent-protocol §4). The subscription's
target is `{ type: 'work', workId }`, only ever the run's own Work.

The router does not publish a Work target. It hands the rendered notice to
`Orchestrator.queueEventResume` (`queueEventResume` in
`libs/orchestrator/src/decide.ts`), which records it on the task's
`eventResumes` under the task revision:

- A delivery id the Work already accepted is a duplicate and changes
  nothing; the Work remembers the last 32.
- With no live run, the write adds an `event-resume/<taskKey>/e<seq>` outbox
  entry. While a run holds the Work the event only waits, and that run's
  settlement adds `event-resume/<runId>`. Both are task writes, so an event
  that arrives while the subscribing run is still finishing is neither lost
  nor resumed twice.
- The drain (`admitWorkEventResume`) admits one run for every waiting event
  with `requestSource: 'event'`, request id `event:e<seq>` of the oldest,
  `mode: 'event'` and the notices as `eventNotice`, resuming the newest
  session of the Work's runs when its pipeline can restore one. A run that
  took the Work first makes admission refuse `task-busy`; its own settlement
  hands the events on. The request history makes a repeated admission return
  the first run.
- `MAX_EVENT_RESUMES` (10) resume runs in a row without a human reply
  refuse further events as `event-resume-limit`; a human reply restarts the
  count. With `MAX_PENDING_EVENT_RESUMES` (8) events already waiting on a
  busy Work, one more is refused as `event-resume-full`: the router drops
  that event (`resume-dropped`) and keeps the subscription.
- An operator's cancel of the item (`cancel` with the native Work) drops the
  waiting events and records `eventResumes.canceledAt`; later events are
  refused as `work-canceled` until a caller request (a reply or redispatch)
  reopens the item. Closing a parked item sets `closedAt`, which refuses
  events the same way.
- The router removes a subscription whose Work refuses an event for good:
  unknown, closed, canceled or over its limit.
- Every source resumes Work the same way: Work state and session events
  through `routeAgentEvent`, and GitHub App deliveries through
  `routeGithubAgentEvents`, which drains the outbox after it queues a
  resume. A resume that reopens a done or failed item clears its sessions'
  expiry, as a reply does.

An event-resume is not a reply: it carries no principal, does not reset or
count toward PR remediation rounds, and ignores a waiting delivery the same
way a reply does. The brief gives the notice in its `reply` field with
`mode: event`, and the direct runner frames it as an event, not a human turn.

## Code map

| Need                                                | Source                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Task/run schemas and invariants                     | `libs/orchestrator/src/model.ts`                                                 |
| Admission, renewal, reporting, cancellation, expiry | `libs/orchestrator/src/decide.ts`                                                |
| Atomic store integration                            | `libs/orchestrator/src/orchestrator.ts` and `store.ts`                           |
| Webhook interpretation                              | `apps/console/src/lib/orchestrator-ingest.ts`                                    |
| Queue dispatch and outcome comments                 | `apps/console/src/lib/orchestrator-dispatch.ts`                                  |
| Console dependencies and routes                     | `apps/console/src/lib/orchestrator-runtime.ts`, `apps/console/src/app/api/work/` |
| Provider execution                                  | Console QueueExecutor and the direct-runner image                                |
| Bootstrap and deliverable evidence                  | Native runtime helpers and direct-runner                                         |

## Diagnose by symptom

| Symptom                                                   | Owner                  | First check                                                          |
| --------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| Correct `agent:*` label; no dispatch or admission record  | Orchestrator admission | GitHub App delivery history, then webhook route and Cloud Tasks logs |
| Webhook acknowledgement followed by a queued 4xx/5xx      | Orchestrator admission | App Hosting logs for HMAC, payload interpretation, or store failure  |
| Worker is not claimed                                     | Runner platform        | QueueExecutor health and direct-runner placement                     |
| Failure before the agent step                             | Worker bootstrap       | Direct-runner logs before the provider invocation                    |
| Provider, model, or agent failure                         | Worker runtime         | Agent-step log                                                       |
| Agent exits zero without deliverable evidence             | Worker runtime         | Native verifier log and the expected attempt marker                  |
| Failed worker has no outcome comment                      | Completion path        | Direct-runner completion logs, then Work API logs                    |
| Completion reports success but no outcome comment appears | Outbox drain           | Pending/failed outbox entries from completion or reconcile response  |
| Subscribed session never hears of a Work state change     | Outbox drain           | `agent-event` outbox gauges and drain failure logs for the entry     |
| Subscribed session never hears of a GitHub event          | GitHub agent events    | `GitHub agent events processed` logs for the delivery id             |
| Waiting Work never resumes after its event                | Event-resume           | Router `removed event subscription` warnings, `event-resume` gauges  |
| Task is silent or appears stuck                           | Reconciliation         | QueueExecutor `maintenance tick` logs and the tick response          |
| Console Retry fails                                       | GitHub Work admission  | `github-work-admission.ts` and `backend-actions.ts` mutation         |

## Runner platform boundary

Every GitHub Actions runner lane runs on Actions Runner Controller (k3s,
homelab#1623); `apps/runner-autoscaler`'s own GitHub scale-set runner
management was retired in that issue's Phase 3. What remains:

- `agent-lcars` owns the LCARS QueueExecutor's provider configuration and
  direct-runner image (not a GitHub-registered runner).
- Homelab owns the queue's Kubernetes deployment (`orchestrator.yml`'s
  `kubernetes` stanza: namespace, RBAC, node labels, Secret values, and
  sizing), credentials, and the running queue-executor process, plus the
  separate ARC `AutoscalingRunnerSet` configuration for GitHub Actions runner
  lanes. Kubernetes Jobs are the queue executor's only backend.
- A Homelab configuration change requires a queue-executor restart; an Agent
  LCARS change cannot provision missing capacity.

## Worker runtime boundary

- QueueExecutor direct-runner receives the admitted run identity; it does not
  re-admit the task.
- The agent does not receive `github.token`. It receives its own App token and
  separate telemetry credentials.
- Deliverable evidence is a post-agent gate, not an orchestrator judgement.

See [Deployment boundary](deployment-boundary.md) for credential and
runner-variable ownership.

## Related documentation

| Topic                     | Document                                                        |
| ------------------------- | --------------------------------------------------------------- |
| Orchestrator design       | [`libs/orchestrator/README.md`](../libs/orchestrator/README.md) |
| Agent label vocabulary    | [GitHub label contract](github-label-contract.md)               |
| Fleet-consumable actions  | [Published actions](published-actions.md)                       |
| Variables and credentials | [Deployment boundary](deployment-boundary.md)                   |

## Per-run placement and execution observations

QueueExecutor reports each live Job's placement through
`POST /api/work/v1/runs/{runId}/placement`, using its existing executor
identity, original runner name and exact claim fingerprint. The transaction
rechecks the active task/run, principal, fingerprint and recovery deadline.
It rejects settled/reclaimed attempts and older, future or more than
thirty-second-old samples. These observations do not renew a lease, create a
heartbeat, advance RunState or authorize Job deletion.

The executor samples Jobs and their controller-UID-owned Pods every ten
seconds in a separate five-second-bounded sweep. It publishes only allowlisted
`pending`, `unschedulable`, `scheduled`, `launch-pending` or
`inventory-unavailable` reasons;
raw scheduler messages, node names and credentials are excluded. A suspended
Job remains bootstrapping while awaiting launch; an unsuspended Job with a
missing Pod counts as awaiting placement. An assigned Pod means bootstrapping, including
a Running Pod; only the worker's existing `providerProcessStartedAt` report
proves the provider executable spawned. This milestone does not assert a first
model response. Pod API failure is unavailable; Job API failure leaves the
previous observation to expire after three minutes. Node availability is
never guessed from GitHub or an unavailable inventory. Rotating the sweep
cursor prevents a slow report from starving later claims.

Legacy claims retain the fifteen-minute bound from #2188, including placement
and bootstrap. Display observation traffic cannot extend it. Negotiated
placement-aware claims use the separately fenced startup operation below. The five-minute maintenance cadence normally settles an expired
startup within twenty minutes; it records startup loss, not a model failure.
A normal temporary capacity wait remains placement until that bound, renewed by
each Pending observation for at most one hour from the claim; past that the
sweep records a startup loss and the executor retires the Job that never
placed. A Job the executor reported Pending until that bound is capacity
contention, not an execution attempt (#3392): its successor keeps the
original place in line (`queuedSince`, read through `queueOrderAt`; `createdAt`
stays the run's own creation), it spends neither the task's lost-run budget
nor the revision's attempt count, and only the first wait in a streak
comments on the anchor, saying the run could not start for lack of room.
`MAX_PLACEMENT_WAITS` (6) bounds a streak; the count carries across charged retries and the
loss is recorded as `placement wait budget exhausted`; past it, and for a claim the
executor never reported on, the loss is charged as usual so an unplaceable
run parks instead of holding the head of the queue. Accepted worker heartbeats then use the renewable run lease. Kubernetes' unchanged
7200-second execution limit is an independent backstop (a Pod runtime deadline
on every executor Job; the executor negotiates placement on every claim), not
permission to run after control-plane settlement. Exact-claim foreground retirement and Pod
drain still precede admission of a successor. The one-Pending gate, provider
serialization, requests, selectors, taints and `max_concurrent` are unchanged.

Agents, canonical task history and Work show the same execution phase and
source age; an open tab expires stale placement without replacing its source
clock with a refresh time. Legacy claimed runs without observations show
placement unavailable. Admission alone is no longer coarsened to active
provider work. Runtime qualification requires the normally deployed executor
and console; fixture/browser evidence does not claim live placement capacity.

### Queue placement and startup clocks

The executor sends `placementAware: true` on every claim; the Console echoes it
only when the durable claim carries startupPlacement state, and the executor
fails the poll closed if the response does not acknowledge it. Callers that
omit the flag (console-internal pipelines) retain the claim-time 15-minute
first-heartbeat deadline.

A fresh executor-authenticated `/runs/{runId}/startup-placement` report for the exact
claim fingerprint and bound Job UID renews the finite 15-minute observation
window while its single owned live Pod remains unassigned and Pending. The
controller reports only negotiated, unsuspended Jobs; absent/ambiguous Pods,
terminal or deleting objects, and API failures do not renew the claim. Once
assigned, placement starts the 15-minute bootstrap deadline once. Further
placement reports cannot renew bootstrap or an accepted worker heartbeat.
A stopped observer therefore still expires; placement never records worker
heartbeat or provider startup.

Every executor Job carries the two-hour runtime limit on the Pod, whose kubelet
clock starts after assignment, rather than on the Job's scheduling clock. The
runner stops the provider at the brief's 80-minute budget first, so a
timed-out worker finalizes, verifies published artifacts and reports
`agent-timeout` itself instead of being killed by the Pod limit and settled
`lost`.
Resources, bounded Pending admission and exact retirement authority remain
unchanged. Live qualification requires compatible Console and
controller delivery and a real admitted work item; source tests alone do not
prove deployed behavior.

## Ready deliverable ownership

The ready delivery handoff is unconditional: every deployed worker uses it. An
already merged PR completion records its merge commit, while unmerged ready
handoff uses the handoff contract. An authenticated native implementation completion with an open PR
artifact establishes exact attempt-marker identity, ready state, protected
target policy and squash arming. Pending review and CI transfer to the
existing durable monitor; it does not retain the implementation executor or
declare delivery complete. The target's branch protection decides what review
and checks a merge needs, so the merge itself is final logical landing and ends
monitoring; nothing re-verifies or corrects a merged PR itself. Its merge does
wake conflict remediation for the other open PRs on the same base (see
[automatic PR remediation](#automatic-pr-remediation)). Actionable same-head
feedback on an open PR remains a bounded correction. Normal Run
settlement, credential cleanup and positive physical
retirement release implementation resources. Task.delivery retains logical
ownership; Run.delivery exposes waiting or complete separately from physical
Run execution. The durable monitor-delivery outbox is consumed by
the existing drain, not another worker or capacity ledger. The App's
`pull_request`, `pull_request_review`, `pull_request_review_thread` and
`check_run` webhooks wake the bound PR's entry and drain at once; the hourly
fallback read only covers a dropped webhook.

Current exact-head GitHub reads advance the binding under the existing Task+Run
transaction. Revision changes rebind both records conditionally; stale polls
cannot overwrite a newer revision or generation. A genuine required-check
failure or unresolved review requests one deterministic same-provider successor
only while the original intake principal still holds the applicable operator,
repository and provider authority. Accepted label intent, rather than the immutable
initial provider or incidental execution, determines correction authority.
Temporary provider fallback still requires its existing current source grant
and repository policy. Credential debt and physically retained
claims remain owned by the existing queue/capacity barriers.

An auto-merge arm alone is not landing; the merged PR and its merge commit are.

A delivery binding has two states: waiting until the PR merges, then complete.
A PR closed without merging, or merged into a branch other than the bound
target, drops the binding. There is no runtime-receipt state; a WorkSpec's
legacy `deliveryRuntime` field is accepted and ignored.

Native logical completion emits a distinct `delivery-outcome/<runId>` event
through the existing outcome outbox and session-expiry owner. The original
execution result and settled report event remain unchanged. Native webhooks
receive this event ID as their idempotency key, so delivery retries cannot
replay the earlier execution outcome.

Delivery polling requests the declared App's administration/checks read grants
through its dedicated token purpose. Required GitHub Actions failures must
belong to the current workflow run and attempt's exact check IDs; canceled
draft CI and superseded attempts cannot authorize a successor. Private legacy
commit-status contexts remain unknown without an undeclared grant. Independent
current review feedback remains actionable. A PR closed without merging
releases delivery ownership; an open draft or unarmed PR retains it and does not
request correction.

### Automatic PR remediation

`lib/pr-remediation.ts` corrects open same-repository PRs that no delivery
binding owns: merge conflicts, unresolved review threads from trusted
(`OWNER`, `MEMBER`, `COLLABORATOR` or fleet/review bot) authors, and
current-head blocking reviews. It admits an `implement` run on the PR anchor
under `svc:github-pr-remediation`, picking a provider from the authoring
pipeline with cross-provider quota fallback, and requests a cross-model
`review` after a remediation push. `pull_request`, `pull_request_review` and
`pull_request_review_thread` webhooks wake it; a merged PR sweeps the open PRs
on its base. It defers to a live run on the PR anchor or on any linked closing
issue, to a waiting delivery binding (which keeps its same-provider correction
above), to an agent `PARK`, and to `status:needs-human`, `status:blocked` and
Renovate PRs. Fork PRs are never remediated. After
`MAX_AUTO_PR_REMEDIATION_ROUNDS` consecutive rounds it applies
`status:needs-human`; these blockers otherwise never enter the Decision Inbox. A round that finishes `no-op` at the PR's current head (the agent judged
no change warranted, for example a superseded PR) also applies
`status:needs-human` on the next check, so the PR reaches the Inbox instead
of staying blocked; a new head remediates again. Unresolved threads from
untrusted authors never start a run, but every enrolled ruleset requires
conversation resolution, so a PR blocked only by them is labeled
`status:needs-human` (`reason=untrusted-threads`).

The round count comes from run history and resets only on a human `reply` or
a non-remediation caller run. Removing `status:needs-human` alone fires
`pull_request: unlabeled`, so the label is re-applied while the same blockers
remain; reply on the PR to resume automatic remediation. When review threads
or reviews exceed one GraphQL page, remediation stops and parks only a
conflicting PR.

Every check logs one `lcars-pr-remediation` event (`trigger`, `outcome`
`remediated`/`rereviewed`/`approved`/`skipped`/`error`, bounded `reason`, repository and
number). GitHub GraphQL `errors` envelopes report `reason=graphql-error` with
GitHub's error types. Each five-minute maintenance sweep logs one
`lcars-pr-remediation-census` event: blocked PRs (merge conflict or unresolved
review threads), those with a live run or a waiting delivery owner, and
`stalled` PRs with neither and no PR or run activity for two hours, plus
`complete=false` when the census could not read everything. Homelab turns
both into `node_lcars_pr_remediation_*` gauges and alerts.

## Outline shadow receiver

`/api/control-plane/outline/webhook` is a signed shadow receiver for the
artifact-bridge migration (#3571). It verifies Outline's raw-body HMAC and
five-minute signing timestamp before parsing. Only event/delivery, actor,
document and model identifiers and event time reach its bounded
`lcars-outline-events` structured outcomes; document titles, Markdown,
comments and supplied links are discarded. Both source and delivery activation
default off. The existing bridge remains active until the explicit cutover.

The receiver stays unavailable until its separate signing secret is provisioned
and pinned in App Hosting. Terraform owns the secret container and its narrow
App Hosting grants, never the value. The trusted host keeps the existing
Outline API credential for administrator/creator checks, text hashes
and ended-session fallback. The console has no Outline API credential or
trusted-network access.

Rollout order is secret container/apply, secret version, runtime reference,
then a second Outline webhook for shadow evidence. Host authorization and the
explicit delivery cutover precede enabling subscription admission. Reuse the
existing host agent; do not expose another LAN listener or copy the bridge's
registry into console application state. Retirement and the one-day proof
remain acceptance gates on #3571.

With `AGENT_LCARS_OUTLINE_SOURCE_ENABLED=true`, signed identifier-only jobs
share the existing `agent-event-deliveries` topic and pike's filtered pull.
Pike's existing agent requires `LCARS_OUTLINE_API_KEY` and the independent
`LCARS_OUTLINE_AGENT_USER_ID`; it refuses a key for another user. It rereads
the creator and the actor's current admin role. Own document updates prime
private hashes with revision metadata only when the authoritative own revision
matches the notification. Own comments and repeated observations cannot advance
an existing baseline. External edits
settle for eight seconds before reading Markdown; an unchanged hash suppresses
comment highlights. Baselines distinguish observed/own text from an accepted
admin edit, so reordered bursts coalesce while a delayed own event cannot hide
an administrator's newer change. Failed reads or reports leave hashes unchanged and nack
the job. The Console logs bounded authorization outcomes in shadow mode.

`AGENT_LCARS_OUTLINE_DELIVERY_ENABLED=true` additionally activates routing and
admission. An unobserved document queues a creator check and returns 503;
it creates no subscription. Only a positive pike observation admits a document.
The CLI preserves the setup explanation and marks it retryable. Host and
native Work subscriptions use the normal router, identity and resume rules.
Notices contain generated identifiers and canonical links, never Markdown or
comment text. Deliberately excluded kinds do not trigger fallback comments.

Before publishing a session delivery, the Console saves a metadata-only
receipt naming its host and the signed source notice. A durable routing marker
precedes terminal subscription settlement and survives repeated intake, so a
lost report response cannot create a false unsubscribed fallback. Only that verified host
may report it undeliverable. The Console queues pike's fallback, where
`LCARS_OUTLINE_FALLBACK_ENABLED=true` and a fresh creator check are required.
Pike resolves the parent thread through Outline and supplies a deterministic
comment UUID (supported by [Outline's API](https://www.getoutline.com/developers));
a retry checks that ID before writing. Normal health probes never create
comments. Fallback transport failures nack the original delivery instead of
acknowledging lost work. Source/receipt metadata expires after fourteen days,
beyond Pub/Sub's seven-day retention; creator observations retain only creator
status and whether the document ever had a subscription, with no terminal map.
Pike's observation endpoint can import `previouslySubscribed:true` from the
actual legacy registry only after a positive creator read. This preserves
ended-document fallback without assigning a stale terminal alias to a new
session. Re-subscribe a live legacy target only after its exact session
ownership is verified; a terminal name alone is insufficient evidence.

The existing protected host metrics expose Outline configuration, pending
failed source jobs, successful work, errors and last success. An old last-success
timestamp alone is idle, not failure. Source enqueue failures use the deployed
`lcars-agent-events`/`enqueue`/`failed` alert contract. Complete the owning
Homelab dashboard, loaded rules and Loki verification before activation.

The native worker permits two complete Outline jobs at once, including API
reads and report/fallback waits, while preserving per-document ordering. Queued
jobs retain identifiers rather than document bodies. Held-job count and oldest
held publication timestamp cover queueing, debounce, API, report and ack/nack
waits; both return to zero when empty. Progress alerts must distinguish an old
backlog that is completing jobs from one that is stalled.
