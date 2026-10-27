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
owners, unresolved credential operations and capacity receipts refuse. A
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
same contract; `--fallback-pipelines none` disables an inherited list.

Admission intersects the list with the authenticated principal's pipeline
grant. A failed `provider-limit` report can atomically settle its attempt,
retain the limited provider's cooldown and mint a fresh authorized successor.
It prefers an available authorized alternative. When all remaining alternatives
are temporarily occupied or cooling down, the first authorized unattempted
alternative remains a fresh queued intent; ordinary claim ceilings and cooldowns
hold it until it can run. Missing opt-in, revoked authority or exhausted
alternatives still settle without a successor.
A `provider-capacity` report is the same availability class with no window to wait on: the direct
runner derives it from the provider's own structured failure events when a round stops before any
final message, so an empty last message cannot degrade it to a generic agent failure. It holds that
provider for exactly one bounded probe and never parses a reset, and it keeps the provider's cause
in the reported message. A cross-provider successor still requires the explicit policy and current
grant above; without them the attempt stays failed and the only change is an honest cause.
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
claim deadline; deferred, claimed and unavailable work stays untouched.

Run provenance records the original intent, predecessor, triggering failure
and attempted providers. Alternatives are tried deterministically without
cycles, and cross-provider successors drop session/transcript resume artifacts
while retaining the human request and context. Work/task/conversation views
and outcome delivery identify fresh fallback attempts. Source tests and local
emulator proof qualify this mechanism; protected CI, normal deployment and a
real provider-limit journey remain separate delivery gates.

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

The hermetic Inbox journey keeps a 20-second merge-action allowance, distinct
from #2201's navigation-to-ready phone p95 contract.

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
- The agent does not receive `github.token`. It receives its own App token,
  separate telemetry credentials, and only the explicitly scoped rerun token
  when configured.
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
placed. Accepted worker heartbeats then use the renewable run lease. Kubernetes' unchanged
7200-second execution limit is an independent backstop (a Job deadline for
legacy claims, a Pod runtime deadline for negotiated claims), not permission to
run after control-plane settlement. Exact-claim foreground retirement and Pod
drain still precede admission of a successor. The one-Pending gate, provider
serialization, requests, selectors, taints and `max_concurrent` are unchanged.

Agents, canonical task history and Work show the same execution phase and
source age; an open tab expires stale placement without replacing its source
clock with a refresh time. Legacy claimed runs without observations show
placement unavailable. Admission alone is no longer coarsened to active
provider work. Runtime qualification requires the normally deployed executor
and console; fixture/browser evidence does not claim live placement capacity.

### Queue placement and startup clocks

Executors negotiate `placementAware: true` on claim; the Console echoes it
only when the durable claim carries startupPlacement state. Old callers retain their
claim-time 15-minute first-heartbeat deadline. New callers fail closed if the
claim response does not acknowledge the contract.

A fresh executor-authenticated `/runs/{runId}/startup-placement` report for the exact
claim fingerprint and bound Job UID renews the finite 15-minute observation
window while its single owned live Pod remains unassigned and Pending. The
controller reports only negotiated, unsuspended Jobs; absent/ambiguous Pods,
terminal or deleting objects, and API failures do not renew the claim. Once
assigned, placement starts the 15-minute bootstrap deadline once. Further
placement reports cannot renew bootstrap or an accepted worker heartbeat.
A stopped observer therefore still expires; placement never records worker
heartbeat or provider startup.

Negotiated Jobs retain the two-hour runtime limit on the Pod, whose kubelet
clock starts after assignment, rather than on the Job's scheduling clock.
Resources, bounded Pending admission, exact retirement authority and receipt
fences remain unchanged. Live qualification requires compatible Console and
controller delivery and a real admitted work item; source tests alone do not
prove deployed behavior.

## Ready deliverable ownership

The authenticated brief advertises deliveryHandoffVersion:1; the baked runner
propagates it into provider context. Workers without that capability retain
the existing delivery path. An already merged PR completion records its merge
commit, while unmerged ready handoff uses the new contract. An authenticated native implementation completion with an open PR
artifact establishes exact attempt-marker identity, ready state, protected
target policy and squash arming. Pending review and CI transfer to the
existing durable monitor; it does not retain the implementation executor or
declare delivery complete. The target's branch protection decides what review
and checks a merge needs, so the merge itself is final logical landing and ends
monitoring; nothing re-verifies or corrects a merged PR. Actionable same-head
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
