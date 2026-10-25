# Unified work-item dataflow: declarative intent, observed verification, any agent

Status: proposed design, revised 2026-10-25. Original proposal: [#2810](https://github.com/jlapenna/agent-lcars/pull/2810). It extends [native work items](2026-08-23-native-work-items-design.md) (#1502) and finishes that design's stated end state, in which "every issue-side affordance becomes a control-plane projection" and agents are GitHub-agnostic. The first consumers of generalized dispatch are event-driven fleet issue triage and LLM summaries; named OpenClaw agents are one execution adapter. Nothing ships until each [phase](#phases) lands with its own qualification.

## Problem

Native work items made `work` the source of task text for every anchor (sub-project 5). Three things still fork on GitHub:

1. **Identity.** A GitHub task is keyed `{repo, issue}` and a native task `{workId}`. Single-flight, claims and stale-anchor retirement follow the GitHub key, and outcome reporting branches on it: an issue comment (`orchestrator-dispatch.ts:582`) versus a channel webhook (`:715`).
2. **Execution.** `pipeline` is a closed enum of three CLIs, each needing a repository checkout. Work can't go to an agent whose access lives outside GitHub, such as Joe's OpenClaw agents with their own workspaces, memory and host access.
3. **Completion.** "Done" means the agent wrote `<!-- attempt-claim:<id> -->` into a bot-authored artifact, and `runtime/verify-outcome.sh` found it. That checks that a token was written, not that the requested state exists.

Inbox summaries now use durable Work admission, claims and revision fencing while executing bounded model calls in the Console. Handoff summaries are the next consumer of that lifecycle. Fleet triage has used an hourly OpenClaw sweep. Giving either its own durable queue would duplicate admission, retries and failure visibility. Execution remains sized to the task.

Adding OpenClaw as one more pipeline with a "target is an agent, not a repo" branch would add a fourth fork. This design removes the forks instead.

## Model

Every work item flows through the same four stages. Each stage selects its adapter from admitted configuration, and GitHub appears only as an adapter. A trusted operation delivery policy chooses persist-only or reply-to-origin before the reply adapter runs.

| Stage      | Chosen by                                        | Adapters                                                                                       |
| ---------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1. Intake  | `origin.channel`                                 | `github` (labels, replies), `slack`, `console`, `api`, `cron`                                  |
| 2. Execute | `agent` → registry `runtime`                     | `model-call` (bounded inference), `cli` (coding Jobs), `openclaw` (laforge bridge)             |
| 3. Verify  | each `intent[].kind`                             | look up the referenced state (GitHub API for GitHub intents; the message for reports)          |
| 4. Reply   | trusted `policy.delivery`, then `origin.channel` | `persist-only` → stored result; `reply-to-origin` → channel reply; console `/work/<id>` always |

```
intake adapter ──▶ work item {agent, resources, intent[], origin}
                        │ claim (unchanged queue, leases, fairness)
                        ▼
                 execute adapter ──▶ result {refs[], message, artifact?}
                        │
                        ▼
             check each intent against the referenced state
                        │
                        ▼
                 reply adapter (origin channel), console
```

GitHub shows up in three roles, each kept separate:

- **Channel:** where a request came from and where the reply goes.
- **Resource:** a repository an agent is granted.
- **State:** pull requests and issues that intents are checked against.

None of these roles is a dispatch path.

## Work item shape

```ts
WorkSpec {
  title, description, priority,
  agent: AgentId,                 // registry key
  fallbackAgents?: AgentId[],     // must be registry-compatible
  resources: Resource[],          // empty only if the agent requires none
  intent: Intent[],               // what must be true when done (≥1)
  operation: OperationId,         // trusted, versioned input/result contract
  source?: { key: string },       // stable subject; separate work per operation
  policy: PolicyId,               // trusted deadline/retry/concurrency/delivery policy
}
WorkRound {
  requestId: string,              // semantic event identity; retries reuse it
  input: OperationInput,          // immutable snapshot, validated by operation
  sourceRevision?: string,        // required for event-derived work
}
Resource = { kind: 'repo'; repo: string; access: 'read' | 'write' }
Intent =
  | { kind: 'pull-request'; repo; merged: boolean }
  | { kind: 'issue-state'; repo; issue; state: 'closed' | 'open' }
  | { kind: 'comment' }           // on the origin thread
  | { kind: 'review'; repo; pr }
  | { kind: 'report' }            // the message is the deliverable
  | { kind: 'artifact'; schema: string } // validated structured result
  | { kind: 'none' }              // running it is the point
```

This is a clean break: `pipeline`, `mode`, `fallbackPipelines` and `target` are removed, not aliased. Intake adapters produce the new shape directly. A GitHub `agent:claude` label, for example, maps to `{agent: 'claude', resources: [repo write], intent: [pull-request merged]}`.

## Agent registry

`PIPELINE_CONTRACTS` becomes an agent registry (`libs/dispatch-contracts`). Each entry declares:

- `id`: for example `claude`, `codex`, `opencode`, `openclaw/investigator`.
- `runtime`: `model-call`, `cli` (plus provider), or `openclaw`. Runtime selection does not change the lifecycle owner.
- `accepts`: the resource kinds it can be granted. `cli` agents accept `repo`; `openclaw/investigator` accepts none.
- `requires`: the resources it cannot run without. `cli` agents require at least one `repo`, because the runtime needs a checkout; `openclaw/investigator` requires none.
- `satisfies`: the intent kinds it may be asked for. `openclaw/investigator` satisfies only `report` and `none`.
- `operations`: the versioned input/result contracts and policy IDs this agent supports. Model/provider settings and permissions are trusted configuration, never selected by source text.
- `maxLiveClaims`: moves here from `QUEUE_PIPELINE_MAX_LIVE_CLAIMS`.

The GitHub label (`agent:*`) and reply-trigger config moves into the **GitHub channel adapter** as a map from label or trigger to `{agent, intent}`, so the registry itself has no GitHub fields.

**Admission** refuses a work item unless all of these hold:

- the operation, input, policy and result schema are registered and compatible with the agent
- the policy fixes delivery to `persist-only` or `reply-to-origin`; source text and generated output cannot override it
- the agent `satisfies` every intent
- every resource is in `accepts`, and every `requires` entry is present
- every repo-valued intent names a repo that is also a `resources` entry
- every referenced repo (resources and intents) passes `isControlPlaneRepository()`, as `target.repo` does today in `work-mint.ts`
- when the caller's principal carries a signed `sourceRepository` (OIDC), every referenced repo equals it, as `work-router.ts` enforces for `target.repo` today
- the grant allows the agent (`AGENT_LCARS_WORK_GRANTS` gains `agents: AgentId[]`)

Redispatch and fallback re-run the same checks against the next agent, so a fallback can't widen the repo set or the caller binding.

## Verification: check the state, not a token

The executor's `complete` call carries `{refs: [url], message, artifact?, park?}`. Structured artifacts are validated against the admitted operation's versioned schema and size bounds; arbitrary schema code is never accepted from a caller. For each intent, the Console looks up the referenced thing and checks it against the intent:

| Intent         | Satisfied when                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `pull-request` | A referenced PR is in `repo`; if `merged: true`, it is merged (existing `monitor-delivery` waits).    |
| `issue-state`  | The issue is in the requested state.                                                                  |
| `comment`      | A referenced comment exists on the origin thread.                                                     |
| `review`       | A referenced review exists on `pr`.                                                                   |
| `report`       | `message` is non-empty.                                                                               |
| `artifact`     | The result validates against the admitted schema, with source-current publication checked separately. |
| `none`         | The run finished.                                                                                     |

A failed check is `unsatisfied`, which retries or parks under the existing limits. That's the whole mechanism. The attempt-claim marker and `verify-outcome.sh` are deleted.

**Deliberately not here:** proving which attempt produced an artifact, or proving a report came from a particular process. This is one operator's fleet, with no adversarial agent forging another's work, so attribution and provenance add state without addressing a real risk at this stage. If that changes, it belongs in its own design.

**Limit:** intents are proxies. "PR merged" is not "bug fixed", so intents should be as specific as the request allows. A report's correctness isn't checked; the reply puts it in front of the requester.

## Execute adapters

### `model-call`

A bounded, tool-free inference call returning a registered structured artifact.
It needs no repository checkout, coding CLI, or OpenClaw session. The executor
uses the same durable admission, attempts, leases, cancellation, retry budgets
and result store as every other runtime. A resident executor may serve short
calls; sharing the lifecycle does not require a Kubernetes Job per summary.
The concrete hosting choice must be qualified before enabling this adapter.

LCARS owns the deadline and provider concurrency budget across replicas, not a
process-local semaphore. Calls have bounded input, output, elapsed time and
attempt count. Invalid output is a visible failed attempt under the same finite
retry policy; exhausting that policy leaves source context usable. Provider
credentials stay at the execution boundary. The Console reads the persisted
artifact and never waits on inference during navigation or run settlement.

### `cli`

The existing `direct-runner.sh` path, now reading `agent`, `resources` and `intent` from the brief and completing with `{refs, message}`.

### `openclaw`

The QueueExecutor launches a bridge Job. The Job keeps every LCARS lifecycle duty (claim, lease, heartbeat, startup deadline, `lost`, retries) and runs no model. It hands the attempt to a stateless Homelab-owned OpenClaw plugin, **`lcars-agent-bridge`**, and waits for the answer.

- **Why a Job.** The Console (Firebase App Hosting) can't reach the LAN gateway, but the k3s QueueExecutor can. No OpenClaw credential leaves laforge: the gateway token carries every operator scope, and no RPC token can be limited to one agent.
- **Auth.** The plugin checks the caller's run bearer with `GET /runs/{runId}/introspect`, reusing the investigation gateway's client (agent-lcars#2572). The run must be live, with `agent = openclaw/<name>`. This is access control, so random LAN callers can't drive agents; it isn't provenance.
- **Allowlist.** Plugin config `agents: [...]`. Anything else gets `403`.
- **Turn settings:**
  - session key `agent:<name>:lcars:<attemptId>`, fresh per attempt (never `main` or a shared hook key; see #2484)
  - `idempotencyKey = attemptId`, so a repeated `POST` doesn't start a second turn
  - `deliver: false`, so no chat delivery and `NO_REPLY` is irrelevant
  - timeout 90 minutes, under the 2-hour lease
  - `extraSystemPrompt`: end the reply with the refs, if any
- **Wire.** `POST /lcars/v1/runs` starts the turn. `GET /lcars/v1/runs/<attemptId>` runs every 60s alongside the Job's `heartbeat`. `DELETE` is sent on cancel or lease loss. The Caddy route is `oc.lan.jlapenna.net/lcars/*`, `trusted_only`, bearer-only.
- **No persistence.** The plugin keeps only an in-memory map of live turns. LCARS already holds the run's state, and the agent's session transcript stays in OpenClaw as usual.
- **Concurrency.** One in-flight attempt per agent and two per plugin, answering `409 busy` beyond that. The Job exits as `provider-limit`, so the existing cooldown applies.
- **Job size.** No resource envelope is approved by this proposal. Measure the complete bridge workload, including its runtime, and select supported requests equal to limits for CPU, RAM and storage. Before publishing a Job or runner change, verify that its complete envelope fits one eligible supported runner after reserves using Homelab `docs/k3s.md`; never combine capacities across hosts. No accelerator or checkout is required by the operation.

| Failure                   | Result                                                                       |
| ------------------------- | ---------------------------------------------------------------------------- |
| Gateway down at start     | Retryable exit; the startup deadline settles `lost`.                         |
| Gateway restarts mid-turn | The plugin no longer knows the attempt (`404`) → Job exits → `lost` → retry. |
| Agent busy                | `409` → `provider-limit` cooldown.                                           |
| Cancel or lease loss      | `DELETE` → the plugin aborts the session.                                    |

**First agent: `openclaw/investigator`.**

- **Tools:** profile `minimal`, exec allowlisted to `/usr/local/bin/homelab-investigate` only, with files, messages, sessions, cron and gateway denied.
- **Redaction:** that command redacts probe values itself (`homelab:bin/homelab-investigate`), so a report leaving the LAN contains only redacted output.
- **Registry entry:** it satisfies only `report` and `none`.
- **Unchanged:** the #2572 investigation gateway remains the synchronous mid-run question path for workers.
- **Before enabling:** delete the stale `workspaces/investigator/BOOTSTRAP.md`. Without file tools the agent can't delete it itself.

## Channels

- **GitHub adapter.**
  - Labels and reply triggers map to `{agent, intent}` and create work items.
  - Its existing coding-work binding keeps relabeling or re-triggering on the same work item. Event-derived triage and summaries use separate operation/source bindings; the issue alone cannot identify all three operations.
  - For `reply-to-origin` work, completion replies are issue comments. Persist-only work produces no completion comment or acknowledgement. Triage comment effects belong to its operation and are reconciled separately; they are not generic completion replies. Issue-side acknowledgements for requested coding work stay console-written projections (sub-project 5).
- **Console, CLI and Slack.** All three can assign permitted work to registry agents from phase 4. Each reads the agent list from a new read-only Work API route, `GET /agents` (the registry entries the caller's grant allows), so a new agent needs no channel change.
  - **Console:** the Quick Task dialog (`apps/console/src/app/quick-task-dialog.tsx`) replaces its hard-coded `PIPELINE_OPTIONS` with an agent picker. The intent is chosen from what the selected agent `satisfies`, defaulting to `report` for `openclaw/*`. The reply is the `/work/<id>` page.
  - **CLI/API:** `lcars work create` (`apps/telemetry-watcher`) replaces `--pipeline`/`--fallback-pipelines` with `--agent openclaw/investigator`, `--fallback-agents` and `--intent report`. A new `--wait` polls `/work/<id>` and prints the message; otherwise the item ID is printed for later lookup.
  - **Slack:** the bot (sprinkles repo, HTTP-only consumer) accepts an agent prefix in the root message, for example `investigator: why did the backup alert fire?`. The prefix is resolved against the registry; no prefix keeps today's default agent. The reply goes to the thread through the existing outcome webhook (`AGENT_LCARS_OUTCOME_WEBHOOKS`), with no new mechanism.
- **Cron.** Unchanged, apart from schedules naming `agent` and `intent` instead of `pipeline`.
- **Reply vs deliverable.** These stay separate. A Slack request that produces a PR replies in Slack with the PR link.

## Event admission and result publication

A source is not a task identity. One issue can have separate triage, summary and
coding work without one operation claiming or settling another. Single-flight
for event-derived work is scoped to operation/version plus source; existing
coding claims and human ownership remain admission constraints for effects.

Event admission resolves `(operation/version, source key)` to one stable
`workId`. Each distinct relevant source revision admits an immutable round with
its input snapshot and revision; duplicate events return that same round.
Retries create attempts of that round without changing its input. Coalescing
marks older queued rounds superseded and advances the desired-round pointer;
it never rewrites admitted snapshots. The existing work/task claim owns
single-flight across all rounds, with no second source lock. Round admission,
supersession and desired-round changes must be transactional in the existing
store, and durable draining starts the latest queued round after the live one
settles. The result publication check compares its round/revision against that
current desired round, so input that changes and later changes back cannot
accidentally publish an intervening obsolete round.

The trigger is separate from the operation and executor. GitHub deliveries,
LCARS state changes and explicit user requests enter the existing durable intake
and Work admission path. Summary operations use the trusted `persist-only` delivery policy, including
when their source is a GitHub issue. A browser visit may request a missing summary through
that same idempotent path; it must not create a second inference queue.

- Each event-derived operation uses a stable deduplication key made from its
  operation/version, source key and relevant source revision. Webhook delivery
  IDs suppress duplicate deliveries but do not replace semantic deduplication.
- Persist accepted work or its admission outbox entry before acknowledging the
  event. Replays after crashes must recover the same work. Use existing outbox
  and reconciliation mechanisms; no independent Firestore listener/checkpoint.
- The revision identifies the operation's actual input snapshot. Select input
  fields per operation: unrelated metadata and this operation's own output must
  not cause an endless feedback loop. Comments and review state that affect a
  decision must participate in a summary revision.
- For request-time summaries, order snapshots by the observations of every
  contributing source, captured before fetching and cached with the data. Reject
  a snapshot if any source regresses, or if changed content has no advancing
  observation. Unchanged content advances the observation watermark without
  generating another attempt. A later A → B → A transition is a new occurrence,
  while a delayed replay of the first A cannot replace B.
- Coalesce pending revisions for a source to the latest eligible input. Preserve
  attempt history. An older running attempt may finish, but cannot publish over
  a newer revision; cancellation and supersession are distinct from provider
  failure and do not consume the newer revision's retry budget.
- Result settlement stores the artifact and its input revision. Publication
  compares against the current desired revision atomically at the owning store.
  A stale result remains inspectable as superseded, never shown as current.
- External effects require a current-source check immediately before the write,
  operation-specific idempotency and readback after an ambiguous response.
  GitHub writes cannot be made atomic with LCARS settlement. A timeout after a
  successful write must reconcile that effect before retrying; do not claim
  exactly-once external execution.
- Fairness and capacity remain LCARS-owned. Lightweight summaries use a bounded
  execution budget so coding jobs and triage cannot starve them, and summary
  bursts cannot consume unbounded provider capacity. No new runner pool is
  implicitly authorized by this design.

## First consumers and acceptance

| Consumer                      | Trigger and input                                                                  | Executor                | Validated result and publication                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Inbox decision/report summary | Relevant source or decision revision changes; bounded source snapshot              | `model-call`            | Structured description, attached only to that revision; original context remains accessible                          |
| Human-needed handoff summary  | Run settles with a handoff                                                         | `model-call`            | Structured actions attached to the exact run/handoff revision; settlement never waits for generation                 |
| Fleet issue triage            | Issue opened/reopened or relevant issue/context changes in configured repositories | Registered triage agent | Structured disposition, evidence and intended actions; authorized label/comment effects reconciled before completion |

Triage is one bounded issue operation, not an hourly fleet sweep. Eligibility
and permissions are server-owned: respect human ownership and existing live
claims, suppress self-generated triage changes, and route any subsequent coding
work through normal Work admission. Repeated delivery must not create duplicate
comments or coding dispatches. Closing an issue or changing its eligibility
invalidates pending triage; running work rechecks eligibility before effects.
An initial bounded backfill may admit existing eligible issues through the same
path. Recovery reconciles missing durable admissions without launching periodic
LLM sweeps.

Migration acceptance requires all of the following:

1. Replayed deliveries and a restart between admission and execution recover one
   semantic work item, with visible attempts and finite retries.
2. Source changes during a model call prevent stale publication; the newest
   revision eventually gets its result. Specifically, B arriving while A runs
   and C superseding queued B leaves A unable to publish, B unexecuted, and C
   next under the same Work claim lifecycle. Invalid results, provider failure and
   absent configuration preserve original Inbox content and primary actions.
3. A settled handoff remains settled even if its summary fails. Reports receive
   reading summaries, never invented human decisions or authorization.
4. A real eligible issue event completes bounded triage with read-back effects;
   an ambiguous write response does not duplicate the comment or dispatch.
   An ineligible/claimed issue and the triager's own output do not start a loop.
5. Lease loss, cancellation and executor restart settle/recover through LCARS,
   with source revision, attempts and failure reason visible in Work detail.
6. The replacement is qualified with useful work before retiring its predecessor.
   The hourly triage schedule remains disabled throughout this migration.
   Notifications use Slack; Telegram remains disabled. OpenClaw qualification
   uses the installed approved runtime: no tip-of-tree, source build or implicit
   runtime upgrade is part of this work.

## Task identity

After the work-item and verification phases, GitHub tasks are re-keyed by `workId`:

- Single-flight, claims, assignee projection and stale-anchor retirement key on `workId`.
- The issue becomes the item's origin thread.
- This touches the most incident-hardened invariants (#2410–#2427), so it gets its own phase and qualification. Cutover drains in-flight GitHub tasks first, then switches keys.

## Phases

1. **Inbox summaries through existing Work.** Add an internal Inbox-summary
   specification alongside the public coding specification. Reuse the existing
   task/run store, queue claims, token fencing, outbox and maintenance. Preserve
   coding write contracts and direct-runner Jobs. Store immutable source revisions,
   coalesce pending inputs, fence stale results and cap retries across failures and
   lost claims. Summary outcomes are persisted without notifications. Work read
   views accept both specifications; coding mutation routes reject internal work.
   Admission from an Inbox request is durable before returning; framework-owned
   post-response execution provides prompt service and maintenance recovers it.
   Maintenance executes at most one model call within the remaining request
   budget, reserving settlement headroom inside the ticker’s 60-second deadline.
   This recovery path does not depend on CPU availability after a response.
   Original context stays usable while a summary is pending or unavailable.
   Each background pass claims at most four model calls; the existing maintenance
   pass drains subsequent retries and superseding inputs. Work history exposes
   the executed revision and attempt. Qualified in PR #3017: the deployed Inbox
   rendered the summary for homelab #503 from Work `01M5TK4ZDAGQQC5PAVW5HQM6QH`.
2. **Handoff summaries and shared operations.** Migrate handoff summaries through
   the qualified lifecycle. Extract shared operation contracts only where both
   consumers need them. Qualify source-event intake separately from request-time
   admission. A parked completion atomically records an independent
   `admit-handoff-summary` entry in the existing outbox, so optional summary
   admission cannot delay or replay the outcome notification. The handler admits
   one internal Work item per original run. Its immutable revision stores the
   source run ID and message digest; execution reads that settled message and
   verifies the digest, avoiding duplicate large handoff payloads. A shared
   executor produces validated actions, retaining exact-command checks. Inbox
   readers select the artifact for the exact source run; the original result is
   never rewritten. Failed or pending generation retains the full handoff.
   Three Inbox claims plus one handoff claim preserve a four-call aggregate cap;
   maintenance still executes at most one call within its request budget.
   Remove the synchronous inference path from worker completion when this
   replacement is qualified. Defer public pipeline/target migration and a general runtime registry until the
   agent surfaces require them; update all affected clients together at that time.
3. **Event-driven triage.** Connect existing durable GitHub intake to one
   background Work item per `fleet-triage:v1` issue source. Use the existing
   OpenCode native Job with `deliverable: report`; qualify this path without a
   new runtime, registry, worker pool or OpenClaw change. Keep hourly sweeps
   disabled. Admit open bug issues only, preserving the predecessor's scope;
   the current fleet configuration owns repository eligibility and excludes
   repositories with agents disabled.

   Relevant issue and human-context changes advance the immutable input
   revision. Pending inputs coalesce and stale attempts cannot publish. Closed,
   assigned or already claimed issues, open fixing PRs, agent/review labels and
   unresolved parked coding attempts invalidate pending triage. Preserve trusted
   dispatch parameters when the existing revision lifecycle mints a successor.
   The worker's existing brief context carries only the source identity and
   executing revision, within its 2,000-character limit; it reads current issue
   evidence and repository guidance through existing tools.

   Report workers remain read-only. Their structured report proposes evidence,
   existing metadata labels, a marked triage comment and whether the issue meets
   the existing coding-dispatch gates. Validated report settlement, the pending
   publication record and its existing-outbox entry commit atomically. The
   publisher repeats source and
   ownership checks, updates the stable `fleet-triage:v1` comment, applies only
   permitted existing labels and reads back effects. Adding `agent:opencode`
   happens last and uses normal label intake; never remove/re-add a control
   label to redispatch. Issue closure and assignment changes are outside this
   slice.

   A narrow `Run.triagePublication` record tracks pending, complete, superseded
   or failed publication and effect receipts. Existing outbox leases, retry
   counts and backoff retain ownership of delivery; do not duplicate them in
   the publication record. Work remains running until effects reconcile, shows
   terminal publication failure and retains superseded attempts in history.
   Recovery reads back uncertain effects before retrying; external GitHub writes
   are not claimed to be exactly once. Recorded own comment/label effects do
   not generate another semantic revision, while human edits and ownership
   changes still do. Backfill is bounded and uses this same admission path.

4. **General agent surfaces and intent verification.** Expose permitted agents
   and operations through Console, CLI and Slack. Ship observed-state verification
   and remove obsolete marker verification together. Keep replies separate from
   artifacts; a stored summary need not send a chat message.
5. **Identity cleanup.** Finish the work-ID re-keying described above after
   qualifying and draining the affected in-flight paths.

Each phase ships independently with its own runtime acceptance. This document
and the planned Console requirements do not assert any adapter migration shipped.

## Rejected alternatives

| Option                                                                                                       | Why not                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| GitHub issue as the bus for OpenClaw work                                                                    | Makes GitHub a dispatch path again, which is the opposite of the native-work end state.                           |
| A separate triage listener/local queue or summary-only retry service                                         | Duplicates durable admission, concurrency, retries and failure visibility already owned by LCARS.                 |
| A separate `openclaw` pipeline with an agent-target branch                                                   | The 2026-10-14 draft of this design. It adds a fourth fork instead of removing three.                             |
| Gateway WS RPC from the Job with a gateway or device token                                                   | Puts a full-operator credential in a k3s Secret.                                                                  |
| `POST /hooks/agent`                                                                                          | Returns no reply text, and its error notices pollute the agent's main session (the 2026-10-14 NO_REPLY leak).     |
| Plugin as a second executor claiming runs                                                                    | Duplicates leases and capacity in a process that has been OOM-killed three times this month. Revisit after #2199. |
| Attribution and provenance (assigned branches, signed journals, per-attempt identities, executor-event logs) | Lots of state and new principals, with no adversarial-agent threat to justify them at this stage.                 |

## Non-goals

- Proving which attempt or process produced a deliverable.
- Drift tracking after an item is satisfied.
- Judging the correctness of reports.
- Budget accounting for `openclaw/*` runs.
- Changing the Alertmanager → `oncall` hook path or any agent's tool policy.
- Multi-turn conversations across attempts (see the resumable-conversations design).
