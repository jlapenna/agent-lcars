# Agent LCARS product spec, part 2: fleet management and orchestration

- **Status:** Product specification of record for the agent fleet control
  plane. Originally written from `main` at `608500a`; conversation proof status and
  published-interface claims were reviewed against `e4b1baa` (2026-10-09). Part 1 is
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
  function. It returns a run request or an ignore reason: `wrong-repo`,
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
- **FL-IN-6 [Partial]** Each delivery is evaluated on its own. There is no
  consistency check across an anchor's full label set (for example, two
  `agent:*` labels) and no stale-label cleanup. See R6.

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

### 5.1 Entities

These are stored in the `dispatch-controller` Firestore database.

| Entity                             | Key                                                       | Purpose                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task** (`orchestrator-tasks`)    | Anchor: `owner/name#N` (GitHub) or `work:<ulid>` (native) | The mutex (`activeRunId`), `runCount`, `consecutiveLost`, opaque `work` payload (≤32 KiB), `closedAt`, `revision` for compare-and-set         |
| **Run** (`orchestrator-runs`)      | `<taskKey>/r<n>`                                          | `state`, `pipeline`, `requestId`, `requestSource` (`caller` or `auto-retry`), `params`, `queue`, `leaseExpiresAt`, `result`, `events[]` (≤64) |
| **Outbox** (`orchestrator-outbox`) | entry ID                                                  | Side effects: `dispatch-run` and `report-outcome`                                                                                             |
| **Schedule**                       | ULID                                                      | `cron` (UTC), `spec`, `enabled`, `lastSlotAt`, `lastItemId`, `disabledReason`                                                                 |
| **Provider cooldown**              | pipeline                                                  | Written atomically with a `provider-limit` failure; claims skip that pipeline until it expires                                                |
| **Request binding**                | binding key                                               | Converges historical Quick Task markers to a canonical request                                                                                |

A **WorkSpec** for native items is `{title ≤256, description ≤16 KiB, pipeline,
target:{repo}}`. A **WorkOrigin** is `{principal, channel:
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
  `expireLease`, `executorExited`, the `…AndRetry` variants, `closeTask`, and
  `updateTaskWork`. The decision and its outbox entry commit in one store
  transaction.
- **FL-SM-3 [Shipped]** A refused decision returns a typed reason:
  `task-busy`, `duplicate-request`, `stale-lease`, `run-not-live`,
  `not-claimant`, `task-closed`, `work-spec-mismatch`, and others.
- **FL-SM-4 [Shipped]** Each run event records who caused it: `request`,
  `dispatch`, `report`, `operator`, `expiry`, or `executor`.

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
  `unknown-success`.
- **Failure** (emitted by
  `apps/runner-autoscaler/runner-image/direct-runner.sh`): `no-deliverable`,
  `agent-timeout`, `agent-failed`, `verification-failed`, `provider-limit`,
  `worker-control-failed`, `runner-failed`.

`RunResult = {ok, summary ≤4 KiB, ref?, message ≤16 KiB}`. `ref` is set only
for pull-request outcomes (the PR URL); comment and review outcomes carry no
ref. `message` is the agent's final turn, shown in the console
Conversation.

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
  provider, order is FIFO. Server-owned ceilings serialize Codex and
  OpenCode, and pipelines in cooldown are skipped.
- **FL-CL-3 [Shipped]** Before issuing a run token for an implement run, the
  server reads the anchor's GitHub state, with a 4s deadline:
  - If the anchor is closed, the run is canceled.
  - If the state cannot be read, the run is released back to the queue with
    `deferredUntil`.
- **FL-CL-4 [Shipped]** A claim refreshes the 2h lease (`RUN_LEASE_MS`).
  Queued runs never expire. The run token is stored only as a SHA-256 hash,
  and the claimant is recorded both as its self-reported runner name and as
  its authenticated subject.
- **FL-CL-5 [Partial]** There is no priority field. FIFO within a provider
  cannot express "urgent". See R4.

### 6.3 Executor and runtime

- **FL-EX-1 [Shipped]** The QueueExecutor (`apps/runner-autoscaler`, Go) is a
  singleton. Before each claim it reserves capacity by counting unfinished
  Jobs and checking node readiness, taints, and free resources.
- **FL-EX-2 [Shipped]** Each run gets one deterministic Kubernetes Job:
  - The Job is created suspended. A per-run token Secret is created, then the
    Job is resumed.
  - `restartPolicy: Never`, `backoffLimit: 0`, a 2h deadline, and a 1-day TTL.
  - A sweep every 15 minutes deletes orphaned suspended Jobs and prunes
    finished Jobs, keeping at most five per `max_concurrent` slot within
    the last 24h.
- **FL-EX-3 [Shipped]** Operator controls: `SIGUSR1` toggles drain (stop or
  resume claiming), and `SIGHUP` only revalidates the config. Configuration
  lives in `orchestrator.yml` and is owned by Homelab:
  - `server`.
  - `kubernetes`: `namespace`, `kubeconfig`, `credentials_secret`,
    `service_account`, `max_concurrent`, `node_selector`, `requests`,
    `limits`, and `tolerations`.
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
  4. Launch the provider, with a 7200s timeout per provider.
  5. Verify the outcome.
  6. Call `/complete`.

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
  `POST /runs/{id}/exit`, which only the claimant subject plus runner name may
  call. The run settles `lost` immediately. Lease expiry, swept by the 5-minute
  maintenance tick, is the backstop.
- **FL-RT-2 [Shipped]** A lost run is auto-retried with request ID
  `retry:<lostRunId>` up to `MAX_AUTO_RETRIES` = 2. After that the task is
  left for a human, and the outcome comment says to re-add the label. A
  finished `ok:false` run is never auto-retried.
- **FL-RT-3 [Shipped]** A `provider-limit` failure writes a cooldown that lasts
  until Claude's reported reset time (if it is within 7 days), or re-probes
  after 15 minutes. Claims do not reroute to another provider.
- **FL-RT-4 [Shipped]** Only an explicit `park` result adds
  `status:needs-human`. A later successful non-park run removes it, with
  generation guards so an older run cannot clear a newer park.
- **FL-RT-5 [Partial]** A launch that fails before any heartbeat can wait for
  most of a 2h lease before retry when no exit report arrives. See R3.

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

| Requirement                     | Rule                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FL-WP-1 Orientation**         | Read `AGENTS.md`, then the protocol, then the `$AGENT_DISPATCH_CONTEXT` brief. Human reply text in the brief is untrusted.                                                                           |
| **FL-WP-2 No takeover noise**   | The console already reacted and assigned. The worker posts no claim or takeover comment.                                                                                                             |
| **FL-WP-3 Progress**            | Report progress only through `lcars session title` and `lcars session status`, not issue comments.                                                                                                   |
| **FL-WP-4 Deliverable by mode** | implement/issue: open a PR. implement/PR: push to its branch. implement/work: open a PR, or write park or no-op. review: submit a review with a body. reply: a comment may be the whole deliverable. |
| **FL-WP-5 Evidence marker**     | The deliverable carries `<!-- attempt-claim:<attemptId> -->`, where `attemptId = g<generation>:<runId>`, plus `Fixes #N`, `Tracks #N`, or `Work: work:<id>`.                                         |
| **FL-WP-6 Park**                | One comment with the claim marker and `<!-- agent-result:v1:park -->`. For native work, write it to `NATIVE_WORK_OUTCOME_FILE`. A timeout, quota limit, or setup failure is not a park.              |
| **FL-WP-7 PR hygiene**          | Push early. Never request review. Arm `gh pr merge --auto --squash` and read it back. Re-read all feedback before arming. Respect holds.                                                             |
| **FL-WP-8 Budget discipline**   | One diagnosis, then one targeted action. Never self-apply `ci:*` labels, except an authorized `ci:run-functional-e2e`.                                                                               |
| **FL-WP-9 Hard limits**         | No `--no-verify`, no plain force-push, no workflow edits, no deploys, and no IAM changes.                                                                                                            |

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
  - Legacy jobs remain for callers that still use `GITHUB_TOKEN`:
    `restore-main-checks`, `close-orphaned-anchors`, and a legacy-arm
    migration.
- **FL-CM-3 [Shipped]** Maintainer merge actions are available in the console:
  Approve & Merge, Approve & Rebase, Rebase, Unstick, Clear needs-human,
  Assign pipeline, and Close.
- **FL-CM-4 [Shipped]** CI behavior is governed by repository variables:
  `<LANE>_ENABLED` (missing means on) and `<ACTION>_ARMED` (missing means off;
  for example `DEPLOY_ARMED` and `POST_SUBMIT_ARMED`). They are read through
  the `control-flag` action.

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
  [canonical smoke ledger](../native-work-smoke-runbook.md#tagged-gate-re-gating-three-live-proofs-2026-09-06):
  Claude [#1794](https://github.com/jlapenna/agent-lcars/issues/1794#issuecomment-5557261018)
  archived `6c2030cb-cebc-4d3d-953c-13b8fd390cd1` in both rounds;
  OpenCode [#1797](https://github.com/jlapenna/agent-lcars/issues/1797)
  archived `ses_f8ab9b701ffeQe92wumRW83s16` in both rounds on 2026-09-06.
  [#1798](https://github.com/jlapenna/agent-lcars/issues/1798#issuecomment-5557319183)
  proved Codex capture only before hitting quota; the
  [2026-09-07 real-work proof](../native-work-smoke-runbook.md#2026-09-07-pass--restore-and-codex-exec-resume-on-real-work)
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
  [2026-09-06 ledger](../native-work-smoke-runbook.md#slack-threads-sub-project-5-2026-09-06--inbound-and-outbound-pass-one-hop-unproven)
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
- **FL-OB-2 [Shipped]** `apps/telemetry-watcher` runs in two places:
  - As a host daemon for interactive sessions, with an allowlist privacy
    boundary.
  - As a runner sidecar with `sidecar`, `finalize`, and `resume` modes. The
    `finalize` mode uploads transcripts to
    `gs://…/runs/<runId>/<agent>/<session>.jsonl`.
- **FL-OB-3 [Shipped]** `apps/github-actions-exporter` exports Prometheus
  metrics for workflow runs, jobs, durations, queue time, oldest queued job,
  and consecutive failures. Label cardinality is bounded.
- **FL-OB-4 [Shipped]** Loki, Prometheus, and LiteLLM logs are owned by
  Homelab and used by the `debug-agent-run` skill. Terraform
  (`infra/terraform/monitoring.tf`) declares two Cloud Monitoring alerts on
  `dispatch-webhooks`: a backlog of more than 200 tasks, and non-ok task
  attempts above 0.05/s for 30 minutes.
- **FL-OB-6 [Shipped] Session retention.** Sessions of an open native item
  carry no expiry. When the item closes, the console dispatches
  `work-session-expiry.yml`, which gives the item's telemetry sessions an
  `expireAt` retention deadline (`lib/session-expiry.ts`,
  `bin/session-expiry.ts`). Reopening the item clears it again.
- **FL-OB-5 [Proposed]** Define fleet SLOs (§13) as recording rules and
  alerts, rather than leaving them to ad hoc investigation.

## 11. Fleet, identity, and infrastructure boundaries

- **FL-FM-1 [Shipped] Onboarding**
  ([`onboarding-repo.md`](../onboarding-repo.md)):
  1. Bootstrap the target repository: labels, hooks, validation, and
     instructions.
  2. Give it runner capacity: QueueExecutor's shared pool, plus a
     Homelab-owned ARC lane only when workload or isolation demands one.
  3. Install both GitHub Apps.
  4. Add it to Agent LCARS: the label manifest, `AGENT_LCARS_WATCHED_REPOS`
     and `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (which must match exactly),
     and the label-audit matrix. Member CI that dispatches through the Work
     API also needs the repository in the `workflow:member-automation` grant.
  5. Audit the setup (`onboarding-audit.yml`).
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
    and `control-flag`.
  - Reusable workflows: `renovate-auto-approve`, `agent-automerge-reusable`,
    `repo-validation`, and `codeql-reusable`.
  - The direct-runner image.
- **FL-FM-4 [Shipped] Authority separation.** These authorities are
  deliberately distinct:
  - Work grants (`AGENT_LCARS_WORK_GRANTS`, with scopes `work.operator`,
    `work.executor`, and `work.cron`). `work.reaper` is not a grantable
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
| R1  | Unify the "needs a human" surface: native parks and GitHub `status:needs-human` in one queue (see part 1, open question 1)           | Native parks currently surface only on the Bridge                                                                                 | P0       |
| R2  | Graduate worker-policy enforcement (FL-WP-11), provider by provider, behind a measured rollout                                       | The protocol's hard limits are currently honor-system at runtime                                                                  | P0       |
| R3  | Shorten launch-failure detection (FL-RT-5) with a first-heartbeat deadline, such as 10 minutes, that settles `lost` early            | A failed launch can stall a task for about 2h                                                                                     | P1       |
| R4  | A priority field on runs (for example `urgent`, `normal`, `background`), honored inside provider-fair selection                      | Scheduled maintenance work and urgent fixes currently share one FIFO                                                              | P1       |
| R5  | Verify the genuine human Slack reply hop (FL-RC-3) and session continuity on the current Kubernetes backend                          | Historical three-provider continuity and Slack inbound/outbound proofs exist; human Slack reply and current-backend proofs remain | P1       |
| R6  | Anchor-level label consistency: reject or resolve multiple `agent:*` labels, and clean up stale routing labels after an outcome      | Per-delivery evaluation can leave labels that contradict state                                                                    | P2       |
| R7  | Optional provider fallback on `provider-limit` (reroute to an allowed pipeline instead of waiting out the cooldown), opt in per task | During a Claude weekly-limit window, runs wait for days. That was 15 of 59 failures in the 2026-09-11 audit                       | P2       |
| R8  | A highly available QueueExecutor, or a server-side distributed `max_concurrent`                                                      | The singleton is a single point of failure                                                                                        | P2       |

R9 is retired: [#1298](https://github.com/jlapenna/agent-lcars/issues/1298)
is closed, and the hosted provider workflows whose YAML copies it concerned
no longer exist. Surviving interface owners are the
[published actions](../published-actions.md#contract-verification),
[dispatch registry](../../libs/dispatch-contracts/README.md), and generated
[Work OpenAPI](../api/work-v1.openapi.json). This is not a requirement to
restore deleted workers or their run-name tests. The live `AGENT_BOT_LOGINS`
variable remains configuration; registry tests do not validate its live value.

## 13. Success metrics and SLOs

The SLO targets below are proposed.

| Metric                      | Definition                                                                | Proposed target     |
| --------------------------- | ------------------------------------------------------------------------- | ------------------- |
| Admission latency           | Time from webhook receipt to run `running` (queued)                       | p95 < 60s           |
| Claim latency               | Time from queued to claimed, with capacity available and no cooldown      | p95 < 2 min         |
| Evidence rate               | Share of finished runs with a verified deliverable, park, or no-op        | > 95%               |
| Successful-attempt rate     | Share of attempts ending `ok`; the 2026-09-11 audit baseline was 18 of 77 | Trend upward; > 60% |
| Silent loss                 | Runs that are live past `leaseExpiresAt` plus one tick                    | 0                   |
| Outbox health               | `failed` (dead-letter) outbox entries                                     | 0 sustained         |
| Human-touch rate            | Share of tasks that need a park or manual action before merge             | Track; reduce       |
| Cost per merged deliverable | Session cost ÷ merged PRs, by pipeline                                    | Track               |

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
