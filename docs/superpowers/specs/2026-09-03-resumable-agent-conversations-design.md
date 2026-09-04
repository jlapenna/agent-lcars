# Resumable agent conversations: multi-round work items across GitHub, Slack, and the console

Status: design, awaiting maintainer review. Extends
[native work items](2026-08-23-native-work-items-design.md), whose
sub-project 6 shipped the Claude-only half of this.

## Problem

Every round of agent work on a work item is an ephemeral one-shot session.
When the agent has a question it parks, the item waits for a human, and
the next run starts from nothing: a fresh CLI session that has to
rediscover everything the parked session already knew. The human's answer
does not even reach it on every path.

The fleet has three half-mechanisms today, verified on `main` at
`ec69a439`:

| Path                                                   | Human text reaches the agent | Prior session resumes           | Surfaces                   |
| ------------------------------------------------------ | ---------------------------- | ------------------------------- | -------------------------- |
| GitHub reply comment (`@claude`, `/codex`, `/oc`)      | yes, as `params.reply`       | no, always a fresh session      | GitHub only                |
| Native redispatch with `resumeSessionId`               | no, `REPLY` is forced empty  | yes, Claude only                | Console, `work-create.yml` |
| Slack `/lcars` (sprinkles bot, `supersprinklesracing`) | creates the item only        | n/a, fire-and-forget, no thread | Slack only                 |

Nothing combines "resume the parked session" with "hand it the human's
actual answer", and only Claude can resume at all. The wanted behavior is
one conversation per work item: the agent asks, the human answers on
whichever surface they are looking at, and the same agent session picks
up where it left off inside a fresh container.

## What exists, and what this design builds on

The control plane already has most of the pieces (file references are on
`main` at `ec69a439`):

- **Runs are already a chain.** A `Task` is a per-anchor mutex; every
  round is a `Run` `r<n>` with opaque `params` and a `result`
  (`libs/orchestrator/src/model.ts`). Item state is derived from the
  latest run, never stored (`libs/work/src/derive.ts`).
- **Dispatch is queue-based.** The console makes a run claimable; the
  autoscaler's QueueExecutor starts a fresh container per run
  (`apps/runner-autoscaler/queue_executor.go`) that reads
  `GET /runs/{id}/brief`, runs `direct-runner.sh`, and reports through
  `POST /runs/{id}/complete` with a run token. No GitHub Actions lane
  remains.
- **Transcripts are archived.** The telemetry sidecar's finalize pass
  uploads each session to
  `gs://agent-lcars-session-transcripts/runs/<runId>/<adapter>/<sessionId>.jsonl`
  and writes a session doc with `intentId = runId` and `transcriptGcsUri`
  (`apps/telemetry-watcher/src/lib/finalize.ts`). Claude and Codex archive
  the raw CLI session file. OpenCode archives a sanitized metadata export
  that cannot rebuild a session.
- **Claude resume is proven.** `redispatch` with `resumeSessionId` puts
  `resumeSessionId`/`resumeTranscriptGcsUri` on the new run's `params`;
  the brief surfaces it; `direct-runner.sh` calls
  `sidecar.cjs runner resume` to write the transcript into
  `~/.claude/projects/<slug>/` and passes `--resume <id>`
  (`apps/runner-autoscaler/runner-image/direct-runner.sh:99-104,231-253`).
  The live proof on 2026-08-27 showed the resumed session recalling a
  codeword from a prior run under a different run id
  (`docs/native-work-smoke-runbook.md`, section 6).
- **Reply text has a channel.** `Run.params.reply` reaches the brief and
  `prepare-dispatch.sh` writes it into the dispatch context (4,000
  character budget). Label redispatches also append up to five new anchor
  comments since the last dispatch (#1566).
- **Parking is a first-class outcome.** The agent ends with
  `PARK <blocker and resume trigger>`, posts a marker comment on a GitHub
  anchor, or writes the two-line outcome file on a native anchor
  (`agent-protocol` section 4). The runner classifies it and reports
  `outcome: park`.
- **Slack already has a bot with the right shape.** The sprinkles
  members bot (`apps/members/bot/src/modules/lcars/`) is a Bolt app in
  HTTP mode subscribed to `message.channels` and `message.im`, with
  `chat:write`, and it already holds `work.operator` on the `claude`
  pipeline through the ordinary grant list (#1571).

### Verified CLI facts

Checked against the installed binaries on 2026-09-03. The OpenCode
export/import round trip was measured on 2026-09-04 (see "Measured:
OpenCode export and import" below) and is no longer an assumption; the
Codex column is measured in plan 3. OpenCode event shapes are still for
the real-path proof.

| Concern                        | Claude Code 2.1.260                                                           | Codex CLI 0.151.0                                                                                       | OpenCode 1.18.21                                                            |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Session store                  | `~/.claude/projects/<cwd slug>/<id>.jsonl`, one file                          | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, plus SQLite indexes it rebuilds            | `~/.local/share/opencode/opencode.db` (SQLite)                              |
| Archived today                 | raw file                                                                      | raw rollout file                                                                                        | sanitized metadata export only                                              |
| Restore into a fresh container | write the file (shipped)                                                      | write the rollout file under `$CODEX_HOME/sessions/<date>/`                                             | `opencode import <export.json>`                                             |
| Headless resume                | `claude -p --resume <id> "<prompt>"`                                          | `codex exec resume <uuid> --json "<prompt>"`                                                            | `opencode run --session <id> --format json "<prompt>"`                      |
| Session id after resume        | unchanged (proven)                                                            | unchanged; `codex exec fork` mints a new one                                                            | unchanged; `--fork` mints a new one                                         |
| Capture the id on a first run  | the watcher reads it from the file; `--session-id <uuid>` can also force it   | the `--json` stream's `thread.started` event; the watcher reads it from `session_meta`                  | `--format json` events, or `opencode session list` after the run            |
| Capture the final message      | `--output-format json`, `.result`                                             | `-o <file>` (`--output-last-message`)                                                                   | last assistant text part in the `--format json` stream                      |
| Working-directory binding      | slug of the cwd; the runner checkout path is fixed at `$RUNNER_TEMP/checkout` | `session_meta.cwd` is recorded; `--all` disables cwd filtering for the picker; explicit id is by lookup | sessions carry a project directory; the fixed checkout path keeps it stable |

The fixed checkout path is what makes all three bindings stable across
containers: `direct-runner.sh:196` checks out into
`$RUNNER_TEMP/checkout`, and `RUNNER_TEMP` defaults to a constant
(`direct-runner.sh:47`).

### Two inconsistencies found on the way

Both were pre-existing and small, and both were fixed the day this design was written: #1759 (park item state, closes #1757) and #1760 (resume-archive slug, closes #1758). The quick-task button's own state derivation had the same park bug; #1763 tracks it.

1. **A park reads as `done` on a native item.** #1608 (2026-08-29) added
   `park` to `run-result.ts`'s `OK_OUTCOMES`, so a park completes with
   `ok: true`. `deriveItemState` reads a finished `ok: true` run as
   `done`, not `parked`. The design spec's decision ("completion with
   `ok: false`; the item reads `parked`") and the 2026-08-27 proof both
   predate this. No test pinned the item state a park produced; #1759 added one at the `/complete` boundary.
2. **The operator tool computes a different project slug.**
   `packages/fleet-tools`'s `resume-archive` slugs the cwd with
   `sed 's/[\/.]/-/g'`; the canonical `claudeProjectSlugFor`
   (`libs/telemetry/src/lib/runner-capture.ts`) replaces every
   non-alphanumeric character. They disagreed for a path containing `_` or `+`; #1760 aligned the tool and added a table test copied from the canonical spec.

## Goals

- One work item is one conversation. Every round after the first resumes
  the previous round's CLI session, for Claude, Codex, and OpenCode.
- A human can answer the agent's question on a GitHub issue or PR thread,
  in a Slack thread, or on the console, and the answer is the next turn
  of the same session.
- The agent's question, or its final message, is a durable field on the
  run that every surface renders from, not something recovered from a
  transcript.
- No new store, no new credential material, no new executor. Extend the
  run chain, the brief, the runner script, and the sidecar.

## Non-goals

- Keeping a container alive between rounds (see option C).
- Multi-agent or multi-human threads with interleaved turns while a run
  is live. A reply during a live run is refused, not queued, in v1.
- PR review-comment threads (`pull_request_review_comment`). The GitHub
  App does not subscribe to them; adding that is a documented procedure
  (`docs/github-app-webhook-events.md`) and a follow-up.
- Cross-CLI resume. A reply that switches pipeline starts a fresh session
  with the reply text, exactly as today.
- A Slack app owned by this repo. Slack is an adapter in sprinkles.

## Options

### Option A: runs are the turns (recommended)

Keep the run chain as the conversation. Each round is a run; the human's
turn is `Run.params.reply` (with the channel and principal it came from);
the agent's turn is a new `Run.result.message`. One channel-neutral reply
primitive mints the next run with both the reply and the resume request.
The GitHub ingest, the Slack adapter, and the console all call it.
Continuity is the CLI's own native resume, generalised from Claude to
Codex and OpenCode by teaching the sidecar's `runner resume` each CLI's
store and `direct-runner.sh` each CLI's resume flag. The console derives
a conversation view from the runs; nothing new is stored beyond fields
on `Run` and one optional binding on `work.origin`.

- Pro: smallest delta over what is shipped and proven. `Run.params` and
  `Run.result` already carry exactly this kind of opaque, per-round data.
  The outbox already delivers per-round outcomes reliably. Every surface
  is an adapter over one route.
- Pro: the conversation is auditable for free, one run per round, and the
  orchestrator's mutex, lease, and retry rules apply unchanged.
- Con: a reply while a run is live has nowhere to go except a refusal.
  On GitHub the comments-since mechanism (#1566) still delivers it on
  the next round; on Slack and the console the adapter tells the human to
  wait.
- Con: the human turn and the agent turn are one-to-one per round. Two
  humans answering the same question produce two rounds.

### Option B: a first-class conversation resource

Add a `turns` subcollection under the task: every message, human or
agent, from any channel, is a turn document with author, channel, text,
and timestamp. A run references the turn range it consumed and appends
the turn it produced. The brief carries every turn since the last run.
The console renders a chat; Slack and GitHub adapters mirror turns in
both directions; replies during a live run simply queue as turns.

- Pro: the natural shape if Slack becomes a primary surface, or if
  several people converse with one item. Queued replies fall out for
  free.
- Pro: the conversation survives independently of runs, so the agent
  can be handed a full thread even when session resume is unavailable
  (a context-replay fallback that is richer than comments-since).
- Con: a second writer to the orchestrator store, a new schema, new
  reaper and retention rules, and two sources of truth for "what did the
  human say" (turns and `params.reply`) during migration. Much of it
  duplicates what a GitHub thread and a Slack thread already are.
- Con: it is a bigger program than the problem needs today. Everything
  in option A is a strict subset, so B can be layered on later if the
  queued-reply and multi-human cases become real.

### Option C: keep the agent process alive

Do not resume at all. When the agent asks a question, the container stays
up with the CLI waiting for input (Claude's `--input-format stream-json`,
Codex's app-server protocol, or `opencode serve`). Replies are pushed into
the live process.

- Pro: perfect continuity with no CLI-specific store manipulation, and
  interactive affordances such as Claude's `AskUserQuestion` become
  usable.
- Con: it inverts the fleet's execution model. A waiting agent holds a
  runner slot (the QueueExecutor cap is one concurrent direct run per
  host), holds credentials for the whole wait, and needs a new lease
  semantics for "idle but alive". Humans answer on human timescales;
  hours of held capacity per question is the normal case, not the edge.
- Con: a lost container mid-wait loses the conversation entirely unless
  transcripts are also archived, at which point option A's machinery is
  needed anyway.

A hybrid (stay alive for a few minutes, then archive and fall back to
resume) is possible later on top of option A and is not designed here.

### Continuity mechanism: native resume, with reply-only as the degrade

Under any option there are two ways to carry context: restore the CLI's
own session and resume it, or replay a rendered transcript into a fresh
prompt. Native resume is the only one that preserves the model's actual
working state (tool results, file reads, its own plan) and it is what is
already proven. Context replay is not built; the existing "fresh run with
the reply text and the anchor's new comments" path is the degrade when no
resumable session exists, and the reply route reports `resumed: false`
so the caller can say so.

### Comparison

| Criterion                             | A: runs are turns                   | B: conversation resource     | C: live process             |
| ------------------------------------- | ----------------------------------- | ---------------------------- | --------------------------- |
| New stored state                      | fields on `Run`, one origin binding | new subcollection, retention | none, but new lease kind    |
| Codex and OpenCode                    | sidecar adapters                    | same adapters                | per-CLI server protocols    |
| Reply while a run is live             | refused (GitHub: next round)        | queued                       | delivered live              |
| Runner capacity per open question     | none                                | none                         | one slot for the whole wait |
| Reuses the proven Claude path         | yes, directly                       | yes, plus new plumbing       | no                          |
| Fit with the ephemeral executor model | exact                               | exact                        | contradicts it              |

Option A is recommended. B is the upgrade path if queued or multi-human
replies become a requirement; C is rejected for the capacity and model
mismatch.

## Recommended design (option A)

### 1. Vocabulary and item states

- **Item**: a task, GitHub-anchored or native, with a `work` payload.
- **Round**: one run `r<n>`. Round 1's human turn is `spec.description`;
  round n>1's human turn is `params.reply`.
- **Conversation**: the ordered rounds of an item, derived, never stored.
- **Parked**: the latest run finished with `result.summary === 'park'`.
  `deriveItemState` keys on the summary since #1759 (inconsistency 1): a park is neither a failure nor done. The runner keeps
  reporting `outcome: park`; `toRunResult` keeps `ok: true` for it (a
  park is a legitimate run outcome), and item state keys on the summary.
  A parked item is exactly an item awaiting a human; no separate
  `awaiting-reply` state is needed because a park always names its
  resume trigger.

Item states stay `running | parked | done | canceled`.

### 2. Data model

No orchestrator schema change. Everything rides on fields the orchestrator
already treats as opaque.

**`Run.params`** (existing `Record<string, string>`), per reply round:

| Key                      | Value                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `mode`                   | `reply`                                                                                   |
| `reply`                  | the human's text, at most 16,384 bytes (raised from 4,000 to match `spec.description`)    |
| `replyChannel`           | `github`, `slack`, `console`, or `api`                                                    |
| `replyPrincipal`         | `github:<login>`, `slack:<user id>`, `user:<login>`, or `svc:<name>`                      |
| `replyRef`               | optional channel address of the human turn: a comment URL, a Slack `ts`                   |
| `resumeSessionId`        | existing                                                                                  |
| `resumeTranscriptGcsUri` | existing; for OpenCode this points at the resumable export, not the sanitized one (see 4) |

**`Run.result`** gains one optional field:

```ts
export const runResultSchema = z.strictObject({
  ok: z.boolean(),
  summary: z.string().max(4_096).optional(),
  ref: z.string().max(1_024).optional(),
  /** The agent's final message for this round, e.g. its question. */
  message: z.string().max(16_384).optional(),
});
```

`POST /runs/{id}/complete` accepts an optional `message` alongside
`outcome`/`outcomeReference`; `toRunResult` copies it through. This is the
design spec's deferred "typed multi-results (`message`)" extension,
triggered now because every surface needs the question text without
reading a transcript.

**`work.origin`** gains an optional thread binding:

```ts
export const workOriginSchema = z.strictObject({
  principal: z.string(),
  channel: z.enum(['api', 'cron', 'console', 'github', 'slack']),
  /** Opaque channel address the originating adapter uses to post
   *  outcomes back into the same thread, e.g. `T…/C…/1725….123456`
   *  for Slack. Only that adapter interprets it. */
  thread: z.string().max(512).optional(),
});
```

It is written once with the rest of `work`, so `requestRun`'s write-once
rule needs no change. GitHub anchors need no binding: the anchor is the
thread.

**Session doc** gains one optional field, `resumeGcsUri`. The finalizer
sets it equal to `transcriptGcsUri` for Claude and Codex, and to the raw
export object for OpenCode. The reply route resolves resume from this
field, not from `transcriptGcsUri`, so the sanitized OpenCode transcript
keeps its current meaning.

### 3. The reply primitive

One helper in `libs/work`, used by every ingress:

```ts
requestReply(task, {
  reply, channel, principal, ref?, pipeline?, resume = true,
}): Promise<{ runId; resumed: boolean } | Refusal>
```

1. The task must be `parked` or `done`. `running` is refused with the
   orchestrator's own `task-busy`; `canceled` is refused with
   `task-closed`. Allowing `done` is deliberate: "one more tweak" on a
   finished item is a reply, not a new item.
2. `pipeline` defaults to the latest run's pipeline. If it differs,
   `resume` is forced off (no cross-CLI resume).
3. When `resume` is on, resolve the resume session: the newest session
   (by `lastActivityAt`) whose `intentId` is one of this task's run ids,
   whose agent matches the pipeline, and which carries `resumeGcsUri`.
   None found: proceed without resume and report `resumed: false`.
4. `requestRun` with the params in section 2, `requestId` derived from the
   channel ref when one exists (a redelivered GitHub comment or Slack
   event maps to the same run) and from `<taskKey>:<runCount+1>` when not.

Exposed natively as `POST /api/work/v1/items/{id}/reply` on the oRPC
contract for `work.operator` principals, input
`{ text, resume?, pipeline? }`, with the principal and channel filled from
the authenticated caller (`console` for a session user, `api` for a
service principal unless the grant names a channel; the sprinkles bot's
grant names `slack`). The existing `redispatch` stays as "retry without
new information". The GitHub ingest calls the helper in-process, as it
calls `orchestrator.request` today.

### 4. Session continuity per CLI

`sidecar.cjs runner resume` gains `--pipeline <claude|codex|opencode>`
and becomes a small adapter table. It prints the local path it restored
and nothing else, exactly as today, and the requested-resume-failed case
stays fatal in `direct-runner.sh` (a requested resume must never silently
become a fresh run).

| Step               | Claude (shipped)                                           | Codex                                                                                                                                                  | OpenCode                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive (finalize) | raw `<id>.jsonl` (unchanged)                               | raw rollout (unchanged)                                                                                                                                | new: `opencode export <id>` without `--sanitize`, uploaded as `runs/<runId>/opencode/<id>.export.json`; the sanitized export and its session doc are unchanged |
| Restore            | write `~/.claude/projects/<slug>/<id>.jsonl`               | write `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<YYYY-MM-DDThh-mm-ss>-<id>.jsonl`, date and timestamp taken from the archived `session_meta` line | `opencode import <file>` via the trusted root-owned binary, the same path `opencode-export-capture.ts` already enforces                                        |
| Resume flag        | `--resume <id>` (unchanged)                                | `codex exec resume <id> --json -o "$LAST_MESSAGE_FILE" "<prompt>"` in place of `codex exec --json "<prompt>"`                                          | `opencode run --session <id> --format json … "<prompt>"` in place of the plain `run`                                                                           |
| Final message      | switch `--print` to `--output-format json`; read `.result` | `-o` file                                                                                                                                              | last assistant text part from the JSON event stream                                                                                                            |
| Session id capture | watcher (unchanged)                                        | watcher from `session_meta` (unchanged); `thread.started` as a cross-check                                                                             | `--format json` events; fallback to `opencode session list` newest for this directory                                                                          |

Ordering in `direct-runner.sh` matters for Codex: the restore must run
after `CODEX_HOME` is allocated and the image config copied in, and
before the auth restore and the `codex exec` call. OpenCode's import must
run after the LiteLLM key file is in place, since `import` opens the same
database the run will use.

Raw OpenCode exports carry tool inputs and outputs, the same class of
content Claude's and Codex's raw archives already carry, and land in the
same private bucket under the same lifecycle. The sanitized export was
bounded because it feeds the console's timeline, not because raw content
was unwelcome in the bucket; this design keeps both artifacts.

### 5. Runner changes

- `prepare-dispatch.sh` stops forcing `REPLY=''` on native anchors. A
  native item now has a maintainer channel: the reply route.
- A reply round gets a reply prompt instead of the generic "work the
  routed anchor" prompt. The CLI already holds the conversation; the
  prompt is the human's turn:

  ```
  A human replied on <channel> (<principal>):

  <reply>

  This continues the same work item. The brief at $AGENT_DISPATCH_CONTEXT
  carries any other new anchor comments. Follow the shared protocol;
  end your response with exactly one of PR <url>, PARK <blocker and
  resume trigger>, or NO-OP <evidence>, and stamp the attempt marker
  exactly as before.
  ```

  A reply round without a resume (no resumable session, or a pipeline
  switch) keeps today's generic prompt with the reply in the brief.

- Every pipeline captures the agent's final message into
  `$RUNNER_TEMP/last-message.txt`, bounded to 16,384 bytes, and the
  completion payload carries it as `message`. On a park this is the
  question; on a PR it is the summary.
- The heartbeat, budget, verify-outcome, and completion paths are
  unchanged. A resumed round is a normal run with a normal lease.

### 6. Surfaces

Every surface does the same two things: deliver the agent's `message`
for a round to the human, and turn the human's answer into
`requestReply`.

**GitHub issue and PR threads.** Inbound: `interpretIssueCommentEvent`
gains an implicit-reply branch. When the anchor's task is parked and an
`OWNER`/`MEMBER`, non-bot comment arrives, the comment is a reply: the
helper is called with the comment body, `github:<login>`, the comment's
URL as `ref`, and the parked run's pipeline. The explicit triggers keep
working and may switch pipeline. The agent's own park comment is a bot
comment and never triggers. The implicit branch sits behind a repository
control flag (`docs/ci-control-flags.md` pattern) for rollout, because
it changes what an ordinary maintainer comment on a parked issue does.
Outbound: the agent's park comment already carries the question on the
thread under the legacy protocol; under `control-plane-projections` the
drain's outcome comment includes `result.message`, so the thread sees
the question either way.

**Slack threads.** The sprinkles bot is the adapter; this repo stays
Slack-agnostic. Inbound: `/lcars` posts a visible root message ("Filed
task `<id>` for `<repo>`") instead of an ephemeral one and creates the
item with `origin.channel: 'slack'` and `origin.thread` set to that
message's address. Thread replies (`message.channels` with a `thread_ts`
the bot recorded, from an allow-listed user) call
`POST /items/{id}/reply` with the bot's existing service identity; the
user id travels as the principal. Outbound: the outbox's `report-outcome`
entry, which today posts a GitHub comment for GitHub anchors and does
nothing for native ones, gains a third case: an item whose origin names
a `thread` is delivered to that channel's registered webhook
(`AGENT_LCARS_OUTCOME_WEBHOOKS`, a JSON map from channel to URL and
audience, in `libs/env-vars`). The console signs the call with its
runtime identity's Google ID token; the bot verifies it and posts
`message` (and `ref` when present) into the thread. The outbox's lease,
retry, and dead-letter rules apply, which is why this is an outbox case
and not a direct call from the completion route. A reply from a
different surface still gets its answer in the Slack thread, because
delivery keys on the item's origin, not on where the reply came from.

**Console.** `/work/[id]` gains a reply box that calls the reply route,
enabled when the item is parked or done, and a conversation view derived
from the runs: for each round, the human turn (`spec.description` with
`origin.principal` for round 1, otherwise `params.reply` with
`replyPrincipal` and `replyChannel`) followed by the agent turn
(`result.message`, plus `ref` and the session link). The resume checkbox
goes away: resume is the default and the reply route reports `resumed`
in its response. The session page's resume-command note for Codex and
OpenCode sessions is replaced by the same archive-resume command once
`fleet-tools` gains the two adapters (a small follow-up; inconsistency 2 is already fixed by #1760).

### 7. Concurrency, budgets, and failure modes

- A reply during a live run is refused with `task-busy`. GitHub:
  comments-since delivers it on the next round anyway; Slack and console:
  the adapter tells the human the agent is still working. Queued replies
  are option B's territory.
- Rounds are human-initiated, so there is no automatic loop to bound.
  Each round is a normal run under the existing lease and the existing
  lost-run retry budget; a lost resumed round is retried by the sweep
  with the same params, including the resume request, because
  `#settleAndRetry` reuses the lost run's params.
- Requested resume that cannot be restored stays fatal in the runner, as
  today. The run fails, the item parks with the failure, and the next
  reply resolves resume again, which will pick the most recent archived
  session.
- A resumed run's session doc keeps the same session id and is rewritten
  with `intentId` pointing at the new run. The item's sessions join
  therefore returns the session once, attached to the latest round, and
  its `resumeGcsUri` is the newest full archive. This is the behavior
  the 2026-08-27 proof observed for Claude and is what makes "newest
  session for this task" the right resolution rule.
- Pinning (`work-session-pin-tick.yml`) already keeps an open item's
  sessions from being reaped; nothing changes.

### 8. Security and authorization

- Reply text is untrusted task context, as `params.reply` is today; the
  prompt says so and the protocol already says so.
- GitHub replies: `OWNER`/`MEMBER`, non-bot, unchanged. Slack replies:
  the bot's allow-list, then the bot's own `work.operator` grant; the
  Slack user id is recorded, not trusted for authorization. Console
  replies: the session user's `work.operator`.
- Session ids continue to pass `isSafeIdentifier` before touching a
  filesystem path. Codex's date and timestamp path components are
  derived from the archived `session_meta` line and validated against a
  fixed pattern before use.
- OpenCode `import` and `export` run only through the trusted root-owned
  binary path, as capture does now.
- The outbound webhook carries only what the console already renders
  (`message`, `ref`, item id, round). No transcript content leaves the
  bucket.

### 9. Testing

- `libs/work`: `deriveItemState` on summary `park`; `requestReply`
  table (parked/done accepted, running/canceled refused, pipeline switch
  disables resume, no resumable session reports `resumed: false`,
  request id derivation from `ref`).
- Contract and router: the reply route's input, auth, and minted
  `params`; `complete` accepting and storing `message`; OpenAPI diff.
- Ingest: implicit reply on a parked anchor, bot and non-member comments
  ignored, explicit trigger precedence, flag off means today's behavior.
- Sidecar: `runner resume --pipeline` per adapter against faked download
  and filesystem; Codex path derivation from a `session_meta` fixture;
  OpenCode import invocation through the trusted-path guard; finalize
  producing `resumeGcsUri` for all three.
- Runner: `direct-runner.test.sh` fixtures asserting the resume flag per
  pipeline, the reply prompt, last-message capture, and the fatal path
  when a requested restore fails.
- Drain: `report-outcome` delivering to a webhook for a `thread`-bearing
  origin, retrying on failure, and still posting a GitHub comment for
  GitHub anchors.
- Console: reply box gating, conversation view rendering, `resumed`
  feedback.

### 10. Real-path proof

One codeword-continuity item per CLI, driven through the real API as
sub-project 6's proof was, plus one round-trip per surface:

1. Console, Claude: create an item that parks with a question; reply
   from `/work/[id]`; the resumed round recalls the codeword and answers;
   the conversation view shows both rounds.
2. GitHub: an issue labeled `agent:claude` parks with a question; a plain
   maintainer comment (no trigger word) resumes it under the flag; the
   answer appears on the thread.
3. Codex: the same codeword item on the `codex` pipeline; confirm
   `codex exec resume <id>` found the restored rollout by id in a fresh
   `CODEX_HOME`.
4. OpenCode: the same on `opencode`; confirm `import` preserved the
   session id and `run --session` continued it in the checkout
   directory.
5. Slack: `/lcars` files an item; the question lands in the thread; a
   thread reply resumes it; the answer lands in the thread.

Each proof records item id, run ids, session ids, and the resumed
round's own status line in `docs/native-work-smoke-runbook.md`.

### 11. Sequencing

Five sub-projects. The first is the foundation; the other four are
independent of each other and can run in parallel worktrees.

1. **Reply primitive and Claude round-trip.** `requestReply`, the reply
   route, `Run.result.message`, the park state fix, the reply prompt,
   `REPLY` no longer forced empty, Claude final-message capture, console
   reply box and conversation view. Proof 1.
2. **GitHub implicit replies.** Ingest branch behind the flag; outcome
   comment carrying `message` under projections. Proof 2.
3. **Codex continuity.** Sidecar adapter, rollout restore, `exec resume`,
   `-o` capture, `fleet-tools` adapter. Proof 3.
4. **OpenCode continuity.** Raw export capture and `resumeGcsUri`,
   `import`, `--session`, message capture, `fleet-tools` adapter. Proof 4.
5. **Slack threads.** `origin.thread`, the `slack` channel, the outbox
   webhook case, and the sprinkles bot changes (root message, thread
   listener, reply call, webhook receiver). Proof 5.

### Measured: OpenCode export and import

Measured on 2026-09-04 against OpenCode 1.18.21, using a real session and
an isolated `XDG_DATA_HOME` so the live database was never written.

| Question                                           | Measured answer                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Does `export` then `import` preserve the session?  | **Yes.** `opencode import` into an empty data directory reported the same id and listed it with its title intact. |
| Does the session id survive the round trip?        | **Yes**, byte-for-byte. So a restored session is addressable by `opencode run --session <id>`.                    |
| Is an isolated data directory honored?             | **Yes.** `XDG_DATA_HOME` redirects the whole store, so a container restore cannot touch anything else.            |
| Can the **sanitized** export carry a conversation? | **No.** See below. This is the finding that decides decision 3.                                                   |

`opencode export --sanitize` preserves a session's _structure_ exactly —
the same 148 messages, 35 text parts, 136 tool parts — while replacing the
_content_ of each with a redaction marker. The first user turn reads
`[redacted:text:<partId>]` instead of its actual words; tool output,
reasoning, the working directory and the repository root are redacted the
same way. Raw and sanitized differ 1,031,211 against 392,223 bytes for the
same session.

The consequence is narrow and decisive: a sanitized export **imports
successfully and resumes into a conversation the model cannot read**,
which is worse than refusing to resume at all, because it looks like it
worked. Archiving the raw export is therefore not a convenience for
OpenCode continuity, it is the only way to have it. The alternative is not
"resume with less content", it is "no OpenCode continuity".

Note that this is about `--sanitize` alone. The artifact archived today is
narrower still: the watcher post-processes that output through
`materializeSafeExport`, which allowlists only ids, roles, timings and
token counts. Neither artifact can rebuild a conversation.

## Decisions for the maintainer

1. **Implicit GitHub replies.** Any maintainer comment on a parked
   anchor resumes the agent (recommended, behind a flag), or only
   comments carrying a trigger word do.
2. **Reply on `done` items.** Allowed (recommended) or parked only.
3. **Raw OpenCode exports in the transcripts bucket.** Same treatment as
   the raw Claude and Codex archives (recommended), or keep OpenCode
   non-resumable. Measurement (below) removes the third option this was
   written to leave open: a sanitized export cannot carry a conversation,
   so there is no middle path, and OpenCode continuity stands or falls on
   this decision alone.
4. **Slack outbound via the outbox webhook** (recommended, reliable and
   consistent with GitHub outcome comments) or the bot polling
   `GET /items?state=parked` on a timer (no new inbound endpoint in
   sprinkles, but per-item dedupe state in the bot).
5. **Reply size.** Raise `reply` to 16,384 bytes to match the
   description (recommended) or keep 4,000.

## Appendix: help output the CLI table was checked against

```
claude 2.1.260
  -r, --resume [value]     Resume a conversation by session ID
  -c, --continue           Continue the most recent conversation
  --fork-session           When resuming, create a new session ID
  --session-id <uuid>      Use a specific session ID for the conversation
  -p, --print              Print response and exit
  --output-format <format> (only works with --print)

codex-cli 0.151.0
  codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
    [SESSION_ID]  Conversation/session id (UUID) or thread name
    --last        Resume the most recent recorded session
    --all         Show all sessions (disables cwd filtering)
  codex exec fork
  --json                        Print events to stdout as JSONL
  -o, --output-last-message     File where the last agent message is written

opencode 1.18.21
  opencode run [message..]
    -c, --continue   continue the last session
    -s, --session    session id to continue
    --fork           fork the session before continuing
    --format         default (formatted) or json (raw JSON events)
  opencode export [sessionID]   export session data as JSON  (--sanitize optional)
  opencode import <file>        import session data from JSON file or URL
  opencode session list | delete <sessionID>
```
