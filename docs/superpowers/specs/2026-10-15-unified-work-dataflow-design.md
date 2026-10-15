# Unified work-item dataflow: declarative intent, observed verification, any agent

Status: proposed design (2026-10-15). No issue yet. It extends [native work items](2026-08-23-native-work-items-design.md) (#1502) and finishes that design's stated end state, in which "every issue-side affordance becomes a control-plane projection" and agents are GitHub-agnostic. Its first new consumer is named OpenClaw agents on laforge. Nothing ships until each [phase](#phases) lands with its own qualification.

## Problem

Native work items made `work` the source of task text for every anchor (sub-project 5). Three things still fork on GitHub:

1. **Identity.** A GitHub task is keyed `{repo, issue}` and a native task `{workId}`. Single-flight, claims and stale-anchor retirement follow the GitHub key, and outcome reporting branches on it: an issue comment (`orchestrator-dispatch.ts:582`) versus a channel webhook (`:715`).
2. **Execution.** `pipeline` is a closed enum of three CLIs, each needing a repository checkout. Work can't go to an agent whose access lives outside GitHub, such as Joe's OpenClaw agents with their own workspaces, memory and host access.
3. **Completion.** "Done" means the agent wrote `<!-- attempt-claim:<id> -->` into a bot-authored artifact, and `runtime/verify-outcome.sh` found it. That checks that a token was written, not that the requested state exists.

Adding OpenClaw as one more pipeline with a "target is an agent, not a repo" branch would add a fourth fork. This design removes the forks instead.

## Model

Every work item flows through the same four stages. Each stage picks one adapter from one field, and GitHub appears only as an adapter.

| Stage      | Chosen by                    | Adapters                                                                                 |
| ---------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| 1. Intake  | `origin.channel`             | `github` (labels, replies), `slack`, `console`, `api`, `cron`                            |
| 2. Execute | `agent` → registry `runtime` | `cli` (claude, codex, opencode Jobs), `openclaw` (laforge bridge)                        |
| 3. Verify  | each `intent[].kind`         | look up the referenced state (GitHub API for GitHub intents; the message for reports)    |
| 4. Reply   | `origin.channel`             | `github` → issue comment, `slack` / `api` → outcome webhook, console `/work/<id>` always |

```
intake adapter ──▶ work item {agent, resources, intent[], origin}
                        │ claim (unchanged queue, leases, fairness)
                        ▼
                 execute adapter ──▶ result {refs[], message}
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
  resources: Resource[],          // may be empty
  intent: Intent[],               // what must be true when done (≥1)
}
Resource = { kind: 'repo'; repo: string; access: 'read' | 'write' }
Intent =
  | { kind: 'pull-request'; repo; merged: boolean }
  | { kind: 'issue-state'; repo; issue; state: 'closed' | 'open' }
  | { kind: 'comment' }           // on the origin thread
  | { kind: 'review'; repo; pr }
  | { kind: 'report' }            // the message is the deliverable
  | { kind: 'none' }              // running it is the point
```

This is a clean break: `pipeline`, `mode`, `fallbackPipelines` and `target` are removed, not aliased. Intake adapters produce the new shape directly. A GitHub `agent:claude` label, for example, maps to `{agent: 'claude', resources: [repo write], intent: [pull-request merged]}`.

## Agent registry

`PIPELINE_CONTRACTS` becomes an agent registry (`libs/dispatch-contracts`). Each entry declares:

- `id`: for example `claude`, `codex`, `opencode`, `openclaw/investigator`.
- `runtime`: `cli` (plus provider) or `openclaw`.
- `accepts`: the resource kinds it can be granted. `cli` agents accept `repo`; `openclaw/investigator` accepts none.
- `satisfies`: the intent kinds it may be asked for. `openclaw/investigator` satisfies only `report` and `none`.
- `maxLiveClaims`: moves here from `QUEUE_PIPELINE_MAX_LIVE_CLAIMS`.

The GitHub label (`agent:*`) and reply-trigger config moves into the **GitHub channel adapter** as a map from label or trigger to `{agent, intent}`, so the registry itself has no GitHub fields.

**Admission** refuses a work item unless all three hold:

- the agent `satisfies` every intent
- every resource is in `accepts`
- the grant allows the agent (`AGENT_LCARS_WORK_GRANTS` gains `agents: AgentId[]`)

## Verification: check the state, not a token

The executor's `complete` call carries `{refs: [url], message, park?}`. For each intent, the Console looks up the referenced thing and checks it against the intent:

| Intent         | Satisfied when                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `pull-request` | A referenced PR is in `repo`; if `merged: true`, it is merged (existing `monitor-delivery` waits). |
| `issue-state`  | The issue is in the requested state.                                                               |
| `comment`      | A referenced comment exists on the origin thread.                                                  |
| `review`       | A referenced review exists on `pr`.                                                                |
| `report`       | `message` is non-empty.                                                                            |
| `none`         | The run finished.                                                                                  |

A failed check is `unsatisfied`, which retries or parks under the existing limits. That's the whole mechanism. The attempt-claim marker and `verify-outcome.sh` are deleted.

**Deliberately not here:** proving which attempt produced an artifact, or proving a report came from a particular process. This is one operator's fleet, with no adversarial agent forging another's work, so attribution and provenance add state without addressing a real risk at this stage. If that changes, it belongs in its own design.

**Limit:** intents are proxies. "PR merged" is not "bug fixed", so intents should be as specific as the request allows. A report's correctness isn't checked; the reply puts it in front of the requester.

## Execute adapters

### `cli`

The existing `direct-runner.sh` path, now reading `agent`, `resources` and `intent` from the brief and completing with `{refs, message}`.

### `openclaw`

The QueueExecutor launches a bridge Job. The Job keeps every LCARS lifecycle duty (claim, lease, heartbeat, startup deadline, `lost`, retries) and runs no model. It hands the attempt to a stateless Homelab-owned OpenClaw plugin, **`lcars-agent-bridge`**, and waits for the answer.

- **Why a Job.** The Console (Firebase App Hosting) can't reach the LAN gateway, but the k3s QueueExecutor can. No OpenClaw credential leaves laforge: the gateway token carries every operator scope, and no RPC token can be limited to one agent.
- **Auth.** The plugin checks the caller's run bearer with `POST /runs/{runId}/introspect`, reusing the investigation gateway's client (agent-lcars#2572). The run must be live, with `agent = openclaw/<name>`. This is access control, so random LAN callers can't drive agents; it isn't provenance.
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
- **Job size.** About 50m CPU, 64 MiB request and 128 MiB limit, no accelerator, no workspace volume. Before merging, check this envelope against the current runner-capacity contract for the selected pool.

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
  - It keeps a durable `repo#issue → workId` index, so relabeling or re-triggering lands on the same item.
  - Replies are issue comments, and issue-side acknowledgements stay console-written projections (sub-project 5).
- **Console, CLI and Slack.** All three can assign work to any registry agent from phase 3. Each reads the agent list from a new read-only Work API route, `GET /agents` (the registry entries the caller's grant allows), so a new agent needs no channel change.
  - **Console:** the Quick Task dialog (`apps/console/src/app/quick-task-dialog.tsx`) replaces its hard-coded `PIPELINE_OPTIONS` with an agent picker. The intent is chosen from what the selected agent `satisfies`, defaulting to `report` for `openclaw/*`. The reply is the `/work/<id>` page.
  - **CLI/API:** `lcars work create` (`apps/telemetry-watcher`) replaces `--pipeline`/`--fallback-pipelines` with `--agent openclaw/investigator`, `--fallback-agents` and `--intent report`. A new `--wait` polls `/work/<id>` and prints the message; otherwise the item ID is printed for later lookup.
  - **Slack:** the bot (sprinkles repo, HTTP-only consumer) accepts an agent prefix in the root message, for example `investigator: why did the backup alert fire?`. The prefix is resolved against the registry; no prefix keeps today's default agent. The reply goes to the thread through the existing outcome webhook (`AGENT_LCARS_OUTCOME_WEBHOOKS`), with no new mechanism.
- **Cron.** Unchanged, apart from schedules naming `agent` and `intent` instead of `pipeline`.
- **Reply vs deliverable.** These stay separate. A Slack request that produces a PR replies in Slack with the PR link.

## Task identity

After the work-item and verification phases, GitHub tasks are re-keyed by `workId`:

- Single-flight, claims, assignee projection and stale-anchor retirement key on `workId`.
- The issue becomes the item's origin thread.
- This touches the most incident-hardened invariants (#2410–#2427), so it gets its own phase and qualification. Cutover drains in-flight GitHub tasks first, then switches keys.

## Phases

1. **Work item and registry.** The new `WorkSpec` replaces `pipeline`/`mode`/`target` outright, including all 17 `target.repo` call sites. The agent registry, grant `agents`, admission checks and the GitHub adapter's label/trigger map ship together.
2. **Verification.** `complete` takes `{refs, message}`. The per-intent checks ship, and the marker and `verify-outcome.sh` are deleted in the same change.
3. **OpenClaw executor.** The Homelab plugin (landed disabled), the bridge Job, the console agent picker, `lcars work create --agent/--intent/--wait`, and the Slack agent prefix (a sprinkles-repo PR). Enable `openclaw/investigator` and qualify:
   - a console Quick Task to `openclaw/investigator` shows its report at `/work/<id>`
   - `lcars work create --agent openclaw/investigator --intent report --wait` prints the report
   - a Slack `investigator: …` message gets the report in its thread
   - a forced gateway restart mid-turn yields one `lost` plus one retry
4. **Identity.** Re-key GitHub tasks by `workId` (above).

Each phase ships independently. Phases 1–3 deliver the OpenClaw capability; phase 4 finishes the identity cleanup.

## Rejected alternatives

| Option                                                                                                       | Why not                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| GitHub issue as the bus for OpenClaw work                                                                    | Makes GitHub a dispatch path again, which is the opposite of the native-work end state.                           |
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
