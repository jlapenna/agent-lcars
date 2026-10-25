# Agent LCARS product spec, part 2: fleet management and orchestration

- **Status:** Product specification of record for the agent fleet control
  plane. Originally written from `main` at `608500a`; requirement statuses,
  state model, runtime, worker contract, published interfaces, and roadmap
  were reviewed against `6515f8f` (2026-10-12). Part 1 is
  [the console](console-product-spec.md).
- **Authority:** Code, configuration, and generated contracts define current
  behavior. When this spec and the code disagree, the code wins and this spec
  should be corrected. Canonical owners for the details are:
  - [`libs/orchestrator`](../../libs/orchestrator/README.md): state machine.
  - [`lifecycle-systems.md`](../lifecycle-systems.md): dispatch ownership.
  - [agent protocol](../../agents/shared/skills/agent-protocol/reference/agent-protocol.md):
    worker behavior.
  - [`deployment-boundary.md`](../deployment-boundary.md): the Homelab
    handoff.
- **How to read it:** each requirement has an ID (`FL-…`) and is marked
  **[Shipped]**, **[Partial]**, or **[Proposed]**. Shipped and partial items
  describe what exists today. Proposed items are the recommended backlog in
  [§12](#12-gaps-and-roadmap).

---

## 1. Product summary

Agent LCARS turns requests (GitHub labels and replies, Work API calls,
schedules, Slack) into **accountable, single-flight agent runs** on a
self-hosted runner fleet. It then drives each run's deliverable through
review and merge, and parks the run for a human when the agent cannot
proceed.

The core promises:

1. **One live run per task.** A durable per-task mutex with an audit trail.
   A duplicate request is refused, never queued twice.
2. **Every run ends in evidence.** A successful run must produce an artifact
   (a PR, comment, or review) stamped with its attempt marker, or an explicit
   park or no-op. "Exited zero" is not success.
3. **Nothing is silently lost.** Leases, executor exit reports, and a
   reconciliation tick settle every run. Bounded auto-retry follows, then a
   park for a human.
4. **Provider-agnostic.** Claude Code, Codex, and OpenCode are interchangeable
   _pipelines_ behind the same admission, queue, protocol, and evidence
   contracts.
5. **A fleet, not a repo.** Member repositories consume published actions,
   reusable workflows, the shared worker protocol, and the runner image. They
   never import LCARS source.

## 2. Actors

| Actor                | Identity                                                                       | Interacts via                                                                              |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Maintainers          | Console allowlist (`jlapenna`, `lizsprinkles`); Work principal `user:jlapenna` | GitHub labels and replies, the console, the `lcars` CLI                                    |
| GitHub App (fleet)   | `agent-lcars[bot]`; claim assignee `agent-lcars-bot`                           | Webhooks into the console; claim, react, and comment on anchors                            |
| Claude App           | `claude[bot]`                                                                  | Authors Claude pipeline deliverables                                                       |
| QueueExecutor        | Grant with `work.executor` (`svc:telemetry-writer`)                            | Claims runs, launches Kubernetes Jobs, reports exits, ticks                                |
| Dispatched worker    | Per-run token plus its own App token                                           | Brief, checkout token, heartbeat, complete                                                 |
| Member automation    | `workflow:member-automation` (GitHub Actions OIDC, 7 repositories)             | `POST /dispatches/github` from member repositories                                         |
| Work-create workflow | `workflow:work-create` (`codex-agent` service account)                         | `work-create.yml`: create, get, cancel, and redispatch items; create and disable schedules |
| Slack bot            | Sprinkles App Hosting service account, channel `slack`                         | Creates items; receives outcomes over webhook                                              |
| Production verifier  | `svc:production-verifier`                                                      | Authenticated live verification with `work.operator`                                       |
| Session reaper       | `session:expiry` (GitHub OIDC from `work-session-expiry.yml`)                  | Read-only item access (`work.reaper`) to expire sessions of closed items                   |
| Homelab              | Platform operator                                                              | Runs k3s, ARC, and the QueueExecutor deployment; holds credentials                         |

## 3. Goals and non-goals

**Goals**

- G1. Admission is atomic, idempotent, and audited for every request source.
- G2. Fair, capacity-aware execution across providers with different limits.
- G3. A deterministic, verifiable completion contract that does not depend on
  trusting the agent's own claims.
- G4. A human is pulled in only for real decisions: parks, failures past the
  retry budget, and reviews.
- G5. Clear authority boundaries. Each credential grants only its declared
  capability.
- G6. Repositories can be onboarded without code changes to LCARS beyond
  configuration and grants.

**Non-goals**

- Judging deliverable quality. Review is done by humans, review bots, and CI.
  The orchestrator records `RunResult` verbatim and never judges it.
- Queuing a second run behind a live one on the same task.
- Provisioning capacity. Homelab owns hosts, ARC, and Kubernetes sizing.
- Applying deployments, Terraform, or IAM changes from an agent run.

## 4. Intake

### 4.1 Request sources

| Source                                    | Trigger                                                                                                 | Mode                 | Request identity                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------- |
| GitHub label                              | `agent:{claude,codex,opencode}` labeled on an open issue or PR                                          | `implement`          | Webhook delivery GUID               |
| GitHub label                              | `review:{claude,codex,opencode}` on a PR                                                                | `review`             | Delivery GUID                       |
| GitHub reply                              | `@claude`/`@agent`, `/codex`, or `/oc`/`/opencode` in a comment by an `OWNER` or `MEMBER` (never a Bot) | `reply`              | Delivery GUID                       |
| Tagged reply on a parked or finished task | Same commands                                                                                           | `reply` with resume  | Principal `svc:github-tagged-reply` |
| Work API                                  | `PUT /items/{ulid}`                                                                                     | native               | Client ULID (idempotent)            |
| Member CI                                 | `POST /dispatches/github[/redispatch]` with GitHub OIDC                                                 | `implement`/`review` | Caller-supplied                     |
| Console                                   | New work, Retrigger, Reply & dispatch, Redispatch                                                       | native or GitHub     | `console-retry:<uuid>`, ULID        |
| Schedule                                  | A cron slot, evaluated on `/schedules/tick`                                                             | native               | Deterministic per-slot ID           |
| Slack                                     | `/lcars` in the Sprinkles bot                                                                           | native               | ULID, `origin.channel=slack`        |

- **FL-IN-1 [Shipped]** The GitHub App webhook (`/api/control-plane/webhook`)
  verifies the HMAC. It accepts `issues`, `issue_comment`, `pull_request`,
  `pull_request_review`, `check_run`, and `pull_request_review_thread`, and
  returns 202. Deliveries go to the Cloud Tasks queue `dispatch-webhooks`
  (10 concurrent, 100 attempts, 24h, 300s deadline), which calls `/process`.
- **FL-IN-2 [Shipped]** Interpretation (`orchestrator-ingest.ts`) is a pure
  function. It returns a run request, an actionable label conflict, or an ignore reason: `wrong-repo`,
  `malformed-payload`, `unhandled-action`, `anchor-closed`,
  `no-trigger-label`, `no-reply-command`, `untrusted-author`, or
  `unhandled-event`.
- **FL-IN-3 [Shipped]** The label `agent-option:cross-repo` adds
  `params.crossRepo=true`, which grants a cross-repository token. A label
  redispatch carries a `github-comments-since` context, so the agent reads
  only the new discussion.
- **FL-IN-4 [Shipped]** Closing an issue or PR retires any queued, unclaimed
  implement run on it.
- **FL-IN-5 [Shipped]** All GitHub-anchored admission goes through one
  boundary, `github-work-admission.ts`. It returns `accepted`, `busy`,
  `duplicate`, `conflict`, `invalid`, `forbidden`, or `not-found`.
- **FL-IN-6 [Shipped]** Label-triggered admission checks the complete delivered
  anchor label snapshot against the canonical pipeline registry. Multiple
  choices within the trigger's namespace return `routing-label-conflict`
  with the namespace, labels, and explicit maintainer resolution guidance;
  absent/inconsistent snapshots fail closed. `agent:*` and `review:*` are
  independent, so one of each is valid intent (not a promise of simultaneous
  runs or different immutable Work pipelines). Replay and concurrent
  deliveries preserve immutable Work and ownership. The console never
  rewrites routing labels or removes bot assignment after outcomes. Authorized
  resolution follows [the label contract](../github-label-contract.md#resolving-ambiguous-routing-intent).

### 4.2 Pipelines

The registry is `PIPELINE_CONTRACTS` in `libs/dispatch-contracts/src/pipelines.ts`.

| Pipeline   | Implement label  | Review label      | Reply command       | Deliverable author | Concurrency rule                          |
| ---------- | ---------------- | ----------------- | ------------------- | ------------------ | ----------------------------------------- |
| `claude`   | `agent:claude`   | `review:claude`   | `@claude`, `@agent` | `claude[bot]`      | Bounded by executor `max_concurrent`      |
| `codex`    | `agent:codex`    | `review:codex`    | `/codex`            | `agent-lcars[bot]` | Serialized (one global credential lease)  |
| `opencode` | `agent:opencode` | `review:opencode` | `/oc`, `/opencode`  | `agent-lcars[bot]` | Serialized (one shared inference backend) |

- **FL-PL-1 [Shipped]** A Work grant lists the pipelines its principal may
  request. Not every caller may trigger every provider.
- **FL-PL-2 [Shipped]** OpenCode routes through LiteLLM (`homelab/default`
  virtual key). A loopback proxy records the resolved physical model so that
  sessions report the requested route and the resolved backend separately.

## 5. Domain model and state machines

### Authorized label provider handoff

**FL-IN-7 [Implemented; runtime qualification pending]** Replacing the sole
canonical `agent:*` label by a Console administrator requests a source-ordered
handoff through the controller. Delivered full-set validation and immutable
non-provider Work comparison remain mandatory. Original Work and every Run's
provider attribution remain historical facts. The exact unclaimed queued
predecessor is canceled atomically with one fresh successor. Transactional
claim/label races admit at most one useful executor.

Claimed/running attempts refuse handoff; settled/parked attempts also refuse
while any physical claim or credential operation is retained. With those gates
clear, terminal and parked work may start fresh on the requested provider.
Refusal is visible with requested/effective provider, actor and source clock;
it is never an automatically deferred execution request. Reapply after gates
clear. Stale/equal-clock deliveries and unauthorized changes cannot reroute.
Same-provider requests keep ordinary redispatch behavior. Source coverage, CI,
protected delivery and eventual supported runtime proof are separate gates.

### 5.1 Entities

These are stored in the `dispatch-controller` Firestore database.

| Entity                                                                          | Key                                                       | Purpose                                                                                                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task** (`orchestrator-tasks`)                                                 | Anchor: `owner/name#N` (GitHub) or `work:<ulid>` (native) | The mutex (`activeRunId`), `runCount`, `consecutiveLost`, `schedulerDisruptions`, opaque `work` payload (≤32 KiB), `closedAt`, `revision` for compare-and-set       |
| **Run** (`orchestrator-runs`)                                                   | `<taskKey>/r<n>`                                          | `state`, `pipeline`, `requestId`, `requestSource` (`caller`, `auto-retry`, or `provider-fallback`), `params`, `queue`, `leaseExpiresAt`, `result`, `events[]` (≤64) |
| **Outbox** (`orchestrator-outbox`)                                              | entry ID                                                  | Side effects: `dispatch-run` and `report-outcome`                                                                                                                   |
| **Schedule**                                                                    | ULID                                                      | `cron` (UTC), `spec`, `enabled`, `lastSlotAt`, `lastItemId`, `disabledReason`                                                                                       |
| **Provider cooldown**                                                           | pipeline                                                  | Written atomically with a `provider-limit` or `provider-capacity` failure; claims skip that pipeline until it expires                                               |
| **Request binding**                                                             | binding key                                               | Converges historical Quick Task markers to a canonical request                                                                                                      |
| **GitHub anchor** (`orchestrator-github-anchors`)                               | anchor                                                    | Projection of accepted GitHub anchor state                                                                                                                          |
| **Priority position** (`orchestrator-priority-positions`)                       | pipeline                                                  | The durable weighted-priority cursor (FL-CL-5)                                                                                                                      |
| **Capacity receipt** (`orchestrator-capacity`, `orchestrator-capacity-records`) | pool                                                      | Server-owned executor capacity receipts; disabled by default ([executor capacity](../executor-capacity.md))                                                         |

A **WorkSpec** for native items is `{title ≤256, description ≤16 KiB, pipeline,
target:{repo}, priority, fallbackPipelines?}`; `priority` defaults to `normal`. A **WorkOrigin** is `{principal, channel:
api|cron|console|github|slack, thread?}`.

### 5.2 Run lifecycle

```text
            requestRun (mutex free)
                   |
                   v
   +-----------> pending --confirmDispatch--> running --reportResult--> finished
   |               |                            |  \
   |               |  cancelRun                 |   \-- executorExited / expireLease --> lost
   |               v                            v                                         |
   |           canceled  <------cancelRun-------+                                          |
   |                                                                                       |
   +-------------- auto-retry (requestId retry:<lostRunId>) while consecutiveLost ≤ 2 ------+
```

- **FL-SM-1 [Shipped]** `RunState` is one of `pending`, `running`, `finished`,
  `canceled`, or `lost`. The live states are `pending` and `running`, and a
  task has `activeRunId` if and only if one of its runs is live.
- **FL-SM-2 [Shipped]** Every transition is a pure decision in `decide.ts`:
  `requestRun`, `confirmDispatch`, `renewLease`, `reportResult`, `cancelRun`,
  `expireLease`, `executorExited`, the `…AndRetry` variants, `closeTask`,
  `updateTaskWork`, `observePlacement`, and `observeStartupPlacement`. The decision and its outbox entry commit in one store
  transaction.
- **FL-SM-3 [Shipped]** A refused decision returns a typed reason:
  `task-busy`, `duplicate-request`, `stale-lease`, `run-not-live`,
  `not-claimant`, `task-closed`, `work-spec-mismatch`, and others.
- **FL-SM-4 [Shipped]** Each run event records who caused it: `request`,
  `dispatch`, `report`, `operator`, `expiry`, `executor`, or
  `provider-fallback`.

### 5.3 Derived item state

Item state is never stored (`libs/work/src/derive.ts`). The first matching
rule wins:

1. `canceled`: the task has `closedAt`, or the latest run was canceled.
2. `running`: there is no run yet, the latest run is live, or the latest run
   was lost and is still within the retry budget.
3. `parked`: the latest run finished with `summary === 'park'`.
4. `done`: the latest run finished with `ok`.
5. `failed`: the latest run finished without `ok`, or was lost after the
   budget was exhausted.

### 5.4 Run outcomes

- **Success** (`OK_OUTCOMES` in `apps/console/src/lib/run-result.ts`):
  `pull-request`, `merged-deliverable`, `comment`, `review`, `no-op`, `park`,
  `report` (only for an opted-in native report item), `unknown-success`.
- **Failure** (emitted by
  `apps/runner-autoscaler/runner-image/direct-runner.sh`): `no-deliverable`,
  `agent-timeout`, `agent-failed`, `verification-failed`, `provider-limit`,
  `provider-capacity` (the selected model reported it is at capacity),
  `worker-control-failed`, `runner-failed`.

`RunResult = {ok, summary ≤4 KiB, ref?, relatedRefs?, message ≤16 KiB}`.
The runner carries the exact bot-authored, attempt-marker-verified PR,
comment or review permalink through completion into `ref`. Structured
GitHub park/no-op comments retain their own permalink; a parked partial PR
retains its PR `ref` and blocker comment in `relatedRefs` (at most one).
Console outcome, history, deliverable and Conversation links all use
`safeHttpUrl`. Historical results, missing references, native park/no-op
files and failed verification have no invented link. Agent final-message
URLs are never promoted to verified references. `message` is the agent's
final turn, shown in the console Conversation.

### 5.5 Claims and ownership

"Claim" means three different things in this system. Console decides which
executor is working an issue; a human assignee owns it regardless.

| Term              | What it is                                                                                                         | Recorded where                                                                                                      | Defined in        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Anchor claim**  | The fleet has taken an issue or PR.                                                                                | The orchestrator task for the anchor, projected to GitHub as the `agent-lcars-bot` assignee and an `eyes` reaction. | FL-AD-2           |
| **Run claim**     | An executor's lease on one queued run. It schedules execution; it does not tell other executors who owns an issue. | The run's lease and claimant.                                                                                       | §6.2              |
| **Session match** | An interactive or cloud CLI session working the anchor.                                                            | Console's CLI-session telemetry, matched by repository plus branch or recorded PR.                                  | FE-AG-3, FE-CLI-1 |

- **FL-OWN-1 [Shipped]** Console is the single source of truth for which
  executor (a fleet run or a CLI session) is working an anchor. That answer is
  derived only from state Console already holds: the anchor's orchestrator
  task and its live run, and live or idle CLI sessions matched to the anchor.
  A human assignee owns the issue regardless of Console's verdict; Console
  does not report human assignment, so executors check the issue's assignees
  as well.
- **FL-OWN-2 [Shipped]** `lcars work owner <owner/repo>#<n>` (FE-CLI-1) is the
  one query for that answer. Its verdict is `fleet-run`, `interactive-session`,
  or `none`. An incomplete answer (exit 1) means `none` is unproven, not that
  the anchor is free.
- **FL-OWN-3 [Partial]** Every executor asks Console, and checks the issue's
  human assignees, before starting work on an anchor. Dispatched fleet runs are single-flight per task, so admission
  refuses a second run (FL-AD-1). Interactive and cloud sessions run
  `lcars work owner` as the read-only `work-reader` identity and do not start
  when the verdict names someone else. Partial: this is repository guidance,
  not enforced, and the session read's completeness fix is in flight.
- **FL-OWN-4 [Shipped]** Nothing outside Console establishes, refreshes, or
  expires ownership: takeover or "implementing this now" comments, occupied
  local worktrees, draft pull requests, and elapsed time since assignment are
  not claims. An executor never overrides a live claim on its own judgment.
  Executor ownership ends only when the state Console reads ends: the run
  settles (finished, parked, failed, or canceled) or the matching CLI session
  ends or falls outside the 72-hour window. Removing the GitHub assignment
  does not change the verdict, and redispatch starts a new run rather than
  releasing ownership.

## 6. Admission, queueing, and execution

### 6.1 Admission and outbox

- **FL-AD-1 [Shipped]** A request against a busy task is refused (`busy`).
  Admission never refuses because the fleet is full. Runs wait in the queue
  instead; the old global live-run cap is retired.
- **FL-AD-2 [Shipped]** The `dispatch-run` outbox delivery marks the run
  `queue.state=queued` and confirms dispatch (the run becomes `running`). For
  GitHub anchors it then _claims_ the anchor: it adds an `eyes` reaction,
  assigns `agent-lcars-bot`, and reads the anchor back to verify both.
- **FL-AD-3 [Shipped]** Outbox delivery properties:
  - Claims use a 5-minute lease and are ordered for fairness (fewest attempts
    first, then oldest).
  - Failed deliveries back off exponentially, from 1 minute up to 30 minutes.
  - Entries become `failed` dead letters after 72h. Reports older than 24h
    re-check that the anchor is still open before posting.

### 6.2 Claiming

- **FL-CL-1 [Shipped]** The QueueExecutor polls `POST /runs/claim` every 15s
  while it has capacity. The server decides which pipelines the caller may
  claim from its grant.
- **FL-CL-2 [Shipped] Provider-fair selection.** The server picks the provider
  with the fewest live claimed runs, then the oldest head of queue. Within a
  provider, order is FIFO within each priority class. Server-owned ceilings serialize Codex and
  OpenCode, and pipelines in cooldown are skipped.
- **FL-CL-3 [Shipped]** Before issuing a run token for an implement run, the
  server reads the anchor's GitHub state, with a 4s deadline:
  - If the anchor is closed, the run is canceled.
  - If the state cannot be read, the run is released back to the queue with
    `deferredUntil`.
- **FL-CL-4 [Shipped]** A claim refreshes the 2h lease (`RUN_LEASE_MS`) and
  sets a 15-minute first-heartbeat start deadline (`RUN_START_TIMEOUT_MS`).
  Queued runs never expire. The run token is stored only as a SHA-256 hash,
  and the claimant is recorded both as its self-reported runner name and as
  its authenticated subject.
- **FL-CL-5 [Shipped]** Request/run contracts support `urgent`, `normal`
  (including historical defaults), and `background`. Within the selected
  provider a durable 4:2:1 weighted cycle prevents background starvation;
  [the orchestrator policy](../../libs/orchestrator/README.md#priority-within-provider-fair-claims)
  defines the seven-reservation background-head bound, propagation, and
  mixed-version rollout limitation. API, CLI, New work, and schedule
  creation expose priority. #2189 closed after production Console rollout and
  real mixed-priority work.

### 6.3 Executor and runtime

- **FL-EX-1 [Shipped]** The QueueExecutor (`apps/runner-autoscaler`, Go) is a
  singleton. Before each claim it reserves capacity by counting unfinished
  Jobs and checking node readiness, taints, and free resources. An opt-in
  receipt mode (`kubernetes.capacity`) instead uses server-owned capacity
  receipts and requires an attested worker activation before each provider
  launch; it is disabled by default (see R8).
- **FL-EX-2 [Shipped]** Each run gets one deterministic Kubernetes Job:
  - The Job is created suspended. A per-run token Secret is created, then the
    Job is resumed.
  - `restartPolicy: Never`, `backoffLimit: 0`, a 2h deadline, and a 1-day TTL.
  - Normal recovery ticks retire original Jobs only after the existing
    executor identity confirms that exact claim has settled. Foreground
    deletion uses UID/resourceVersion preconditions and admission waits for
    owned Pods to drain. A token refusal or expired live claim is insufficient.
  - A sweep every 15 minutes prunes finished Jobs, keeping at most five per
    `max_concurrent` slot within the last 24h. Legacy Secret-less, never-started
    shells without claim proof retain the guarded two-hour backstop.
- **FL-EX-3 [Shipped]** Operator controls: `SIGUSR1` toggles drain (stop or
  resume claiming), and `SIGHUP` only revalidates the config. Configuration
  lives in `orchestrator.yml` and is owned by Homelab:
  - `server`.
  - `kubernetes`: `namespace`, `kubeconfig`, `credentials_secret`,
    `service_account`, `max_concurrent`, `node_selector`, `requests`,
    `limits`, `tolerations`, and the optional `capacity` receipt block.
  - `arc_lanes`.

  Changes require a restart. The retired keys of the Docker backend and the
  scale-set manager (`fleet`, `github`, `registrations`, `scale_sets`,
  `server.state_path`) are rejected by name at startup.

- **FL-EX-4 [Shipped]** The executor publishes status documents to Firestore
  for the console's Shuttlebay: `kind: queue-executor` and one
  `kind: arc-lane` document per configured ARC lane. It also exposes
  Prometheus metrics under the `github_runner_autoscaler_` prefix:
  - `queue_executor_ready`, `queue_executor_state`,
    `queue_executor_polls_total`, `queue_executor_claims_total`, and
    `queue_executor_launches_total`.
  - `schedule_ticks_total`, `maintenance_ticks_total`, and
    `maintenance_last_success_timestamp_seconds`.

- **FL-EX-5 [Shipped]** The direct runner (`runner-image/direct-runner.sh`)
  runs these steps in order:
  1. Fetch the brief.
  2. Get a checkout token.
  3. Install the shared skills, plus the worker-policy hooks when
     `LCARS_WORKER_POLICY_PROVIDERS` names the pipeline (otherwise this step
     is a no-op).
  4. Launch the provider, with a 7200s timeout per provider. The runner
     heartbeats and reports the observed provider process start.
  5. Verify the outcome.
  6. Call `/complete`.

  Every pipeline (Claude, Codex, OpenCode) reports live telemetry through
  provider hooks, with no selector. A failed hook install warns and continues
  without live telemetry; `runner finalize` still writes the final session
  doc.

  If the agent exits 0 with no deliverable, it gets one completion-correction
  round.

- **FL-EX-6 [Shipped] Credential separation.** The agent never receives
  `github.token`. It receives its own App token, separate telemetry
  credentials, and an optional scoped rerun token:
  - Claude: an OAuth token from a projected file.
  - Codex: `auth.json` brokered through `/runs/{id}/codex-auth` under a global
    lease, waiting up to 30 minutes on a 409.
  - OpenCode: a LiteLLM virtual key.

### 6.4 Loss, retry, and parking

- **FL-RT-1 [Shipped]** If a worker dies without reporting, the executor calls
  `POST /runs/{id}/exit`, which only the claimant subject plus runner name,
  with a matching claim fingerprint, may call. The run settles `lost` immediately. Lease expiry, swept by the 5-minute
  maintenance tick, is the backstop.
- **FL-RT-2 [Shipped]** A lost run is auto-retried with request ID
  `retry:<lostRunId>` up to `MAX_AUTO_RETRIES` = 2. After that the task is
  left for a human, and the outcome comment says to re-add the label. A
  finished `ok:false` run is never auto-retried. A worker Pod preempted by the
  scheduler before its provider started is recovered on a separate budget
  (`MAX_SCHEDULER_DISRUPTION_RECOVERIES` = 2) that does not spend
  `consecutiveLost`.
- **FL-RT-3 [Shipped]** A `provider-limit` failure writes a cooldown that lasts
  until Claude's reported reset time (if it is within 7 days), or re-probes
  after 15 minutes. A `provider-capacity` failure always re-probes after 15
  minutes. Without a fallback policy, nothing reroutes to another provider.
  With an opt-in `fallbackPipelines` order, intersected with the principal's
  pipeline grant, a `provider-limit` or `provider-capacity` failure atomically
  settles the attempt and mints a successor on an authorized alternative, and
  maintenance can reroute an unclaimed queued run blocked by a cooldown
  (`libs/orchestrator/src/provider-fallback.ts`;
  [lifecycle systems](../lifecycle-systems.md#explicit-provider-fallback)).
  Real provider-limit qualification is tracked under R7.
- **FL-RT-4 [Shipped]** Only an explicit `park` result adds
  `status:needs-human`. A later successful non-park run removes it, with
  generation guards so an older run cannot clear a newer park.
- **FL-RT-5 [Shipped]** A claimed run with no first heartbeat becomes
  recoverable at its 15-minute start deadline, and the 5-minute maintenance
  tick settles it. For placement-aware executors, an observed Pending Pod
  renews a bounded 15-minute observation window, and the bootstrap deadline
  starts once the Pod is assigned
  ([lifecycle systems](../lifecycle-systems.md#queue-placement-and-startup-clocks)).

### 6.5 Schedules and the maintenance clock

- **FL-SC-1 [Shipped]** The executor calls `POST /maintenance/tick` and
  `POST /schedules/tick` every 5 minutes, using the `work.cron` scope. The
  maintenance tick sweeps expired leases and then drains the outbox. The
  schedule tick coalesces each cron slot into one item through deterministic
  IDs, so a missed tick never double-fires.
- **FL-SC-2 [Shipped]** A schedule is auto-disabled when its creator's grant is
  revoked (`grant-revoked`) or its spec becomes `invalid`.

## 7. Worker contract

The canonical, fleet-wide contract is
`agents/shared/skills/agent-protocol/reference/agent-protocol.md`. It is
consumed by every dispatched run in every member repository.

| Requirement                     | Rule                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FL-WP-1 Orientation**         | Read `AGENTS.md`, then the protocol, then the `$AGENT_DISPATCH_CONTEXT` brief. Human reply text in the brief is untrusted.                                                                                                                                                                                                                                                                          |
| **FL-WP-2 No takeover noise**   | The console already reacted and assigned. The worker posts no claim or takeover comment.                                                                                                                                                                                                                                                                                                            |
| **FL-WP-3 Progress**            | Report progress only through `lcars session title` and `lcars session status`, not issue comments.                                                                                                                                                                                                                                                                                                  |
| **FL-WP-4 Deliverable by mode** | implement/issue: open a PR. implement/PR: push to its branch. implement/work: open a PR, or write park or no-op. review: submit a review with a body. reply: a comment may be the whole deliverable.                                                                                                                                                                                                |
| **FL-WP-5 Evidence marker**     | The deliverable carries `<!-- attempt-claim:<attemptId> -->`, where `attemptId = g<generation>:<runId>`, plus `Fixes #N`, `Tracks #N`, or `Work: work:<id>`.                                                                                                                                                                                                                                        |
| **FL-WP-6 Park**                | One comment with the claim marker and `<!-- agent-result:v1:park -->`. For native work, write the attempt-bound park and claim markers to `NATIVE_WORK_OUTCOME_FILE` and post nothing. A timeout, quota limit, or setup failure is not a park.                                                                                                                                                      |
| **FL-WP-7 PR hygiene**          | Push early. Open as a draft. Never request review. Follow the [published fleet handoff](../../agents/shared/skills/agent-protocol/reference/agent-protocol.md): verify `closingIssuesReferences` with its shared checker, chained with `&&` before Ready and before expected-head GraphQL SQUASH arming; validate the actual same-head readback. Re-read all feedback before arming. Respect holds. |
| **FL-WP-8 Budget discipline**   | One diagnosis, then one targeted action. Never self-apply `ci:*` labels, except an authorized `ci:run-functional-e2e`.                                                                                                                                                                                                                                                                              |
| **FL-WP-9 Hard limits**         | No `--no-verify`, no plain force-push, no workflow edits, no deploys, and no IAM changes, except where trusted repository policy and the owner's explicit approval cover the specific operation.                                                                                                                                                                                                    |

- **FL-WP-10 [Shipped] Verifier.**
  `apps/runner-autoscaler/runner-image/runtime/verify-outcome.sh` looks for the
  exact marker on a bot-authored PR, comment, or (in review mode) review,
  using paginated REST reads. A failed lookup is reported as
  `verification-failed`, which is distinct from `no-deliverable`.
- **FL-WP-11 [Partial] Runtime enforcement.** Worker-policy and review hooks
  live in `packages/fleet-tools` (see
  [`worker-behavior-enforcement.md`](../worker-behavior-enforcement.md)). They
  exist but are **not enabled in production**, and no provider has graduated
  to them. See R2.

## 8. Completion, review, and merge

- **FL-CM-1 [Shipped]** On `reportResult`, a `report-outcome` outbox entry
  posts an outcome comment on the anchor: ✅ finished, ❌ failed, ⏹️ canceled,
  or the lost/retry text, with the ref and the park message. For native work
  with a registered origin, the entry delivers a webhook to
  `AGENT_LCARS_OUTCOME_WEBHOOKS` instead.
- **FL-CM-2 [Shipped]** Auto-merge comes from the reusable workflow
  `agent-automerge-reusable.yml`:
  - It arms auto-merge on bot-authored, non-draft PRs that do not carry
    `status:needs-human`.
  - It disarms when `status:needs-human` is added.
  - A reconcile job re-arms missed PRs, updates BEHIND branches (at most 5,
    skipping Renovate and Dependabot), and dismisses stale bot
    `CHANGES_REQUESTED` reviews.
  - Merge operations require explicit repository-scoped App identity;
    unsupported `GITHUB_TOKEN` mode fails before mutation. Native events own
    post-merge CI/deployment and issue closure. The bounded migration of an
    existing legacy auto-merge arm to App identity remains.
- **FL-CM-3 [Shipped]** Maintainer merge actions are available in the console:
  Approve & Merge, Approve & Rebase, Rebase, Unstick, Clear needs-human,
  Assign pipeline, and Close.
- **FL-CM-4 [Shipped]** CI behavior is governed by repository variables:
  `<LANE>_ENABLED` (missing means on) and `<ACTION>_ARMED` (missing means off;
  for example `DEPLOY_ARMED` and `POST_SUBMIT_ARMED`). They are declared in
  `config/github-variables.json`; workflows read them directly and surface an
  engaged flag through the `control-flag` action.

## 9. Resumable conversations

- **FL-RC-1 [Shipped]** A _round_ is one run. Round 1's human turn is
  `spec.description`, and round n's is `params.reply` (up to 16 KiB). The run
  records `replyChannel` (`github`, `slack`, `console`, or `api`),
  `replyPrincipal`, and `replyRef`.
- **FL-RC-2 [Shipped]** A reply resumes the prior provider session
  (`resumeSessionId`) when its transcript is archived. If it is not, the reply
  starts a fresh session and passes the reply text through, and the console
  says so. The design is
  [`2026-09-03-resumable-agent-conversations-design.md`](../superpowers/specs/2026-09-03-resumable-agent-conversations-design.md).
  Sub-projects 1–4 have shipped. On GitHub, a resume requires the reply
  trigger tag (`lib/tagged-reply-resume.ts`). The design doc's mention of an
  `AGENT_LCARS_IMPLICIT_REPLY_REPOS` gate is stale; that variable no longer
  exists. Historical session-identity proof is recorded in the
  [canonical smoke ledger](https://github.com/jlapenna/agent-lcars/blob/47c5769bc54cb7258af00619b4315b1c7c09c004/docs/native-work-smoke-runbook.md#tagged-gate-re-gating-three-live-proofs-2026-09-06):
  Claude [#1794](https://github.com/jlapenna/agent-lcars/issues/1794#issuecomment-5557261018)
  archived `6c2030cb-cebc-4d3d-953c-13b8fd390cd1` in both rounds;
  OpenCode [#1797](https://github.com/jlapenna/agent-lcars/issues/1797)
  archived `ses_f8ab9b701ffeQe92wumRW83s16` in both rounds on 2026-09-06.
  [#1798](https://github.com/jlapenna/agent-lcars/issues/1798#issuecomment-5557319183)
  proved Codex capture only before hitting quota; the
  [2026-09-07 real-work proof](https://github.com/jlapenna/agent-lcars/blob/47c5769bc54cb7258af00619b4315b1c7c09c004/docs/native-work-smoke-runbook.md#2026-09-07-pass--restore-and-codex-exec-resume-on-real-work)
  on sprinkles#5177 restored and resumed
  `01a07c4c-1c40-7221-8afb-68e1b4c4b582`, observed in both archives,
  `codex exec resume`, and `thread.started`. Recalling a codeword visible
  in anchor comments is not independent evidence of continuity.
  These are pre-cutover direct-container proofs, not verification of the
  current Kubernetes Job backend; repeat verification there remains a gate.
- **FL-RC-4 [Shipped]** A reply may name a different pipeline. That replaces
  an unclaimed queued run and always starts a fresh session, because provider
  sessions cannot cross providers.
- **FL-RC-3 [Partial]** Slack threads (sub-project 5) have historical inbound
  and outbound proof: the
  [2026-09-06 ledger](https://github.com/jlapenna/agent-lcars/blob/47c5769bc54cb7258af00619b4315b1c7c09c004/docs/native-work-smoke-runbook.md#slack-threads-sub-project-5-2026-09-06--inbound-and-outbound-pass-one-hop-unproven)
  records a mention creating item `01M1W3T2X7KR5Z482XVK5C3837` in six
  seconds and the parked agent question reaching its originating thread.
  The remaining Slack gate is a **genuine human thread reply** reaching
  `POST /items/{id}/reply`, minting a resume run, and demonstrating provider
  session identity. App-authored messages carry `bot_id` and are correctly
  rejected by `isEligibleThreadReply`; preserve that anti-bot gate.
  This historical ledger does not prove the current Kubernetes backend.
  R5 requires the remaining human hop and current-backend verification;
  this correction authorizes no Slack messages or token changes.

## 10. Telemetry and observability

- **FL-OB-1 [Shipped]** `libs/telemetry` normalizes Claude, Codex, and
  OpenCode transcripts into sessions:
  - `SessionSource`: `cli` or `issue-agent`.
  - `SessionLiveness`: `live`, `idle`, `ended`, or `stale`.
  - A run-status classifier: `running`, `timeout`, `cancelled`, `failed`,
    `silent-error`, or `succeeded`.
  - Cost from the provider's `costUSD`, or estimated from `MODEL_RATES`.
- **FL-OB-2 [Shipped]** `apps/telemetry-watcher` reports sessions in two ways:
  - Through provider hooks, on workstations and dispatched workers alike:
    `lcars hook claude|codex|opencode|flush` writes sessions directly to
    Firestore as the telemetry writer, installed with
    `lcars integration install`
    ([hooks telemetry](../hooks-telemetry-design.md)). Dispatched workers
    always use hooks (FL-EX-5).
  - As a runner bundle with `finalize` and `resume` modes. The `finalize`
    mode writes the authoritative ended doc and uploads transcripts to
    `gs://…/runs/<runId>/<agent>/<session>.jsonl`.
  - The polling host daemon and the runner's live polling sidecar are
    retired (hooks telemetry phase 3).
- **FL-OB-3 [Shipped]** `apps/github-actions-exporter` exports Prometheus
  metrics for workflow runs, jobs, durations, queue time, oldest queued job,
  and consecutive failures. Label cardinality is bounded.
- **FL-OB-4 [Shipped]** Loki, Prometheus, and LiteLLM logs are owned by
  Homelab and used by the `debug-agent-run` skill. Terraform
  (`infra/terraform/monitoring.tf`) declares one Cloud Monitoring alert
  policy on `dispatch-webhooks` with two conditions, each sustained for 30
  minutes: a backlog of more than 200 tasks, or non-ok task attempts above
  0.05/s.
- **FL-OB-6 [Shipped] Session retention.** Sessions of an open native item
  carry no expiry. When the item closes, the console dispatches
  `work-session-expiry.yml`, which gives the item's telemetry sessions an
  `expireAt` retention deadline (`lib/session-expiry.ts`,
  `bin/session-expiry.ts`). Reopening the item clears it again.
- **FL-OB-5 [Partial]** The [durable observation contract](../product-lifecycle-metrics.md)
  exposes bounded queue, claim, server-observed OS-spawn, settlement and outbox
  metrics, qualified completed-PR delivery, authorized API-intervention
  incidence and the canonical session-cost proxy. It includes a tested,
  unapplied recording/alert handoff. Unsupported artifact verification,
  human identity, full action history and exact billing joins remain explicit
  unknowns. Issue #2200 owns these source definitions, measurements, accounting
  tests and operator handoff. Homelab collection/alert installation and elapsed
  SLO qualification are separate operational work; the template neither applies
  production monitoring nor establishes SLO attainment.

## 11. Fleet, identity, and infrastructure boundaries

- **FL-FM-1 [Shipped] Onboarding**
  ([`onboarding-repo.md`](../onboarding-repo.md)).
  `node tools/fleet-onboard-run.mjs` runs the repository-change steps end to
  end; App installation and the Homelab Terraform apply stay human steps:
  1. Bootstrap the target repository: labels, hooks, validation, and
     instructions.
  2. Give it runner capacity: QueueExecutor's shared pool, plus a
     Homelab-owned ARC lane only when workload or isolation demands one.
  3. Install both GitHub Apps.
  4. Add it to Agent LCARS: the label manifest, `AGENT_LCARS_WATCHED_REPOS`
     and `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (which must match exactly),
     the label-audit matrix, and the `fleet-member` list in
     `config/github-variables.json`. Member CI that dispatches through the Work
     API also needs the repository in the `workflow:member-automation` grant.
  5. Audit the setup (`tools/verify-onboarding.mjs`, also wrapped by
     `onboarding-audit.yml`).
  6. Prove the complete path with a real dispatch.

- **FL-FM-2 [Shipped] Labels.** `config/github-labels.json` declares each
  fleet repository's labels. Every repository uses the standard `type:*`,
  `status:*`, `agent:*`, and `review:*` families. Other families are
  declared per repository: `agent-option:*`, `intake:quick-task`,
  `bot:renovate`, `app:*`, `planning`, and, for
  `supersprinklesracing/sprinkles` only, `ci:*` and `automation:*`.
  `label-contract-audit.yml` and `tools/sync-github-labels.mjs` keep
  repositories in sync daily. Sprinkles alone declares
  `ci:run-functional-e2e`; its current `e2e.yml` consumes the label as a
  functional-only, affected-project opt-in while the ordinary PR lane is
  paused. Repository instructions supply the narrow standing authorization;
  all other `ci:*` controls retain the explicit-maintainer authorization rule.
- **FL-FM-3 [Shipped] Published interfaces.**
  - Composite actions: `mint-agent-token`, `assert-repo-vars`,
    `merge-live-base`, `setup-nx-remote-cache`, `deploy-verify`, `oidc-post`,
    `control-flag`, and `setup-repo-checks`.
  - Reusable workflows: `renovate-auto-approve`, `agent-automerge-reusable`,
    `repo-validation`, and `codeql-reusable`.
  - The direct-runner image (`homelab-runner:jit-node24`). This repository
    owns its Dockerfile; GitHub Actions never publishes it. Homelab's
    `merge-to-live` cycle runs the canonical publisher after a green `main`,
    builds amd64 and arm64, scans every platform, and then promotes the tag
    ([image publishing](../image-publish-routing.md)). QueueExecutor Jobs
    launch `LCARS_QUEUE_RUNNER_IMAGE` with `imagePullPolicy: Always`.
- **FL-FM-4 [Shipped] Authority separation.** These authorities are
  deliberately distinct:
  - Work grants (`AGENT_LCARS_WORK_GRANTS`, with scopes `work.operator`,
    `work.reader` (the issue-owner query only), `costs.reader` (aggregate Costs budget readout only), `work.executor`, `work.cron`,
    and the `work.capacity.*` scopes). `work.reaper` is not a grantable
    scope. It is fixed to the `session:expiry` identity.
  - The worker's App token.
  - The telemetry writer.
  - The QueueExecutor credential.
  - The maintainer's session.
  - The Terraform executor and the deploy identity.

  The IAM contract is `tools/iam-contract/model.json`, and Homelab detects
  drift against it.

- **FL-FM-5 [Shipped] Infrastructure** (`infra/terraform`):
  - Firestore `(default)` holds telemetry and runner status, and
    `dispatch-controller` holds the orchestrator store.
  - GCS buckets for transcripts, Quick Task evidence, and Codex auth.
  - The Cloud Tasks queue `dispatch-webhooks`.
  - Workload identity federation pools and Secret Manager containers. Secret
    values are never in Terraform.
  - A budget of $5/month.
  - The console runs on Firebase App Hosting (`us-central1`) and deploys only
    from green CI on `main`. The branch ruleset lives in
    `infra/github-ruleset`.

## 12. Gaps and roadmap

| #   | Item                                                                                                                                 | Why                                                                                                                               | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| R1  | Unify the "needs a human" surface: native parks and GitHub `status:needs-human` in one queue (shipped, #2210; part 1 FE-IN-1)        | Native parks now appear in the Inbox beside GitHub decisions                                                                      | P0       |
| R2  | Graduate worker-policy enforcement (FL-WP-11), provider by provider, behind a measured rollout                                       | The protocol's hard limits are currently honor-system at runtime                                                                  | P0       |
| R3  | Shorten launch-failure detection (FL-RT-5) with a first-heartbeat deadline (shipped at 15 minutes, #2264)                            | A failed launch no longer stalls a task for about 2h                                                                              | P1       |
| R4  | A priority field on runs (`urgent`, `normal`, `background`), honored inside provider-fair selection (FL-CL-5, shipped, #2324)        | Scheduled maintenance work and urgent fixes no longer share one FIFO                                                              | P1       |
| R5  | Verify the genuine human Slack reply hop (FL-RC-3) and session continuity on the current Kubernetes backend                          | Historical three-provider continuity and Slack inbound/outbound proofs exist; human Slack reply and current-backend proofs remain | P1       |
| R7  | Optional provider fallback on `provider-limit` (reroute to an allowed pipeline instead of waiting out the cooldown), opt in per task | During a Claude weekly-limit window, runs wait for days. That was 15 of 59 failures in the 2026-09-11 audit                       | P2       |
| R8  | A highly available QueueExecutor, or a server-side distributed `max_concurrent`                                                      | The singleton is a single point of failure                                                                                        | P2       |

R7's explicit opt-in source contract is documented in
[Lifecycle systems](../lifecycle-systems.md#explicit-provider-fallback).
[#2198](https://github.com/jlapenna/agent-lcars/issues/2198) tracks delivery and
real provider-limit qualification separately from local mechanism tests.

The [R8 failover design](../superpowers/specs/2026-10-10-queue-executor-ha-design.md)
selects server-owned capacity receipts and separates source implementation from
Homelab fencing/rollout qualification. The application receipt protocol has
shipped disabled by default
([#2311](https://github.com/jlapenna/agent-lcars/issues/2311)). Receipt-aware
Kubernetes adoption ([#2312](https://github.com/jlapenna/agent-lcars/issues/2312))
and Homelab fencing remain open, and the executor is still a singleton.

R9 is retired: [#1298](https://github.com/jlapenna/agent-lcars/issues/1298)
is closed, and the hosted provider workflows whose YAML copies it concerned
no longer exist. Surviving interface owners are the
[published actions](../published-actions.md#contract-verification),
[dispatch registry](../../libs/dispatch-contracts/README.md), and generated
[Work OpenAPI](../api/work-v1.openapi.json). This is not a requirement to
restore deleted workers or their run-name tests. The live `AGENT_BOT_LOGINS`
variable remains configuration; registry tests do not validate its live value.

## 13. Success metrics and SLOs

The SLO targets below are proposed. The
[provider-process observation contract](../provider-process-measurement.md)
separates admission, queue, claim, bootstrap heartbeat and successful OS spawn.
Its server-observed process clock is not a model-start or useful-outcome claim;
missing historical clocks remain unknown.

Use the [measurement contract](../product-lifecycle-metrics.md) for exact
events, clocks, denominators and unknown handling. The broad definitions
below are product goals, not currently measured acceptance results:
`running` can mean queued, raw `ok` includes parks/no-ops, and retained
claims do not prove provider launch. Never infer those facts from a UI state.

| Metric                      | Definition                                                                                                       | Proposed target                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Intake latency              | Verified webhook receipt to durable Run admission; receipt join currently unknown                                | p95 < 60s                          |
| Claim latency               | Queue to retained claim; capacity-eligible/no-cooldown clock currently unknown                                   | p95 < 2 min                        |
| Provider-process latency    | Retained claim to server-observed OS spawn, exported by the lifecycle snapshot; not model-start latency          | Define after qualified observation |
| Evidence coverage           | Independently verified classifications / finished attempts; parks and no-ops classified separately               | > 95%                              |
| Useful-attempt rate         | Independently verified useful deliverables / settled attempts, not raw `ok`                                      | Trend upward; target provisional   |
| Silent loss                 | Non-queued live runs past execution lease plus one maintenance interval                                          | 0                                  |
| Outbox health               | `failed` (dead-letter) outbox entries                                                                            | 0 sustained                        |
| Human-touch rate            | Unique admitted task cohort needing a verified park/manual action before merge; unresolved tasks unknown         | Track; reduce                      |
| Cost per merged deliverable | [Selected cumulative session cost ÷ unique known-merged PRs](../cost-ledger.md), by pipeline; not joined billing | Track; unknown prices stay unknown |

The Costs view currently exports the selected cumulative-session proxy above.
The eventual product goal is actual joined session billing (including retries)
per independently verified distinct merged PR. Neither the proxy nor this
lifecycle snapshot proves that billing join or a useful-outcome rate.

## 14. Open questions

1. Should Codex and OpenCode serialization stay hard-coded on the server, or
   move into configuration owned by Homelab along with `max_concurrent`?
2. Is cross-provider fallback (R7) acceptable, given that pipelines are
   currently chosen explicitly by the maintainer through the label?
3. Should a park on a GitHub anchor time out and be canceled automatically
   after N days, or stay parked until a human acts?
4. Should native work items be able to target more than one repository, and
   should they carry typed multi-results? Both were deferred in the native
   work design.
