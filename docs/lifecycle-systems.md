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
Claimed Codex terminal transitions reserve exact cleanup authority in the same
transaction as the original result, successor and outbox. Completion handlers
reload that reservation under the authenticated claim fingerprint before
retiring its credential lease; they do not reserve a second cleanup operation
from the pre-settlement snapshot. A result accepted during credential IO keeps
its original acceptance time. Exact operation, fingerprint and mutation-sequence
proof settle it through the same fallback owner with current grants and queue
eligibility, even when recovery occurs after the original execution deadline.
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
real provider-limit journey remain separate delivery and runtime gates.

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

Successful merges emit one sanitized phase summary: `githubMutationMs` covers
approval plus squash merge, `projectionRefreshMs` covers the authoritative
refresh, and `maintenanceMs: 0` records that maintenance is outside the request.
Durations use a monotonic clock and saturate at 300,000 ms; the summary contains
no repository, anchor, actor, provider response, or error text. The hermetic
Inbox journey also records click-to-visible-success separately. These are action
acknowledgement measurements, distinct from #2201's navigation-to-ready phone
p95 contract; compare each milestone against itself under the same fixture and
profile, and retain the 20-second assertion allowance until latency is qualified.

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

The existing startup bound from #2188 remains fifteen minutes from claim to
first heartbeat, including placement and bootstrap. Observation traffic cannot
extend it. The five-minute maintenance cadence normally settles an expired
startup within twenty minutes; it records startup loss, not a model failure.
A normal temporary capacity wait remains placement until that bound. Accepted
worker heartbeats then use the renewable run lease. Kubernetes' unchanged
7200-second active deadline is an independent Job backstop, not permission to
run after control-plane settlement. Exact-claim foreground retirement and Pod
drain still precede admission of a successor. The one-Pending gate, provider
serialization, requests, selectors, taints and `max_concurrent` are unchanged.

Agents, canonical task history and Work show the same execution phase and
source age; an open tab expires stale placement without replacing its source
clock with a refresh time. Legacy claimed runs without observations show
placement unavailable. Admission alone is no longer coarsened to active
provider work. Runtime qualification requires the normally deployed executor
and console; fixture/browser evidence does not claim live placement capacity.
