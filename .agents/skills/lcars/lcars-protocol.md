# LCARS Protocol — `agent-lcars` Repo Delta

Repo-specific conventions for `jlapenna/agent-lcars`. This is a short delta
on top of `.agents/skills/agent-protocol/agent-protocol.md` — read that file
first; everything here just fills in the repo-specific parameters it leaves
open, plus a few hard limits unique to this repo. Where the two disagree,
this file wins for this repo.

This repo is unusual among consumers of the shared file: it's both a
consumer (see `.github/workflows/claude.yml` / `opencode.yml`) and, being
the fleet's own operations console, a **reader** of the conventions it
defines — `apps/console` parses the takeover command, the `status:needs-human`
label, and the fleet-claim assignee straight out of GitHub state produced
by agents following that protocol. That's why several of the "fixed
vocabulary" strings the shared file calls out matter so much here
specifically: this repo's own code is what depends on them.

## Identity

- **Fleet-claim identity: `jclaw-bot`.** This is the owner's identity for
  the whole agent fleet across every repo it works — not specific to
  `agent-lcars`. Claim the anchor issue/PR for the fleet at the start of a
  run via the assignees REST API (agent-protocol.md §10):

  ```bash
  gh api "repos/$GITHUB_REPOSITORY/issues/<N>/assignees" \
    -f 'assignees[]=jclaw-bot' --silent
  ```

  This repo's own console (`apps/console`) reads this exact login as
  `AGENT_FLEET_LOGIN` (`apps/console/src/lib/action-items.ts`) to build its
  "agent fleet has claimed this" view — do not substitute a different
  login here.

- **Maintainer / PR reviewer / park-assignee: `jlapenna`.** Add as PR
  reviewer on every pull request you open (`gh pr create --reviewer
jlapenna`), and use as the assignee in the parking recipe
  (agent-protocol.md §4). The console reads this exact login as
  `MAINTAINER_LOGIN`.

- **Dispatch (current, #1015):** a webhook delivery is interpreted by
  `apps/console/src/lib/orchestrator-ingest.ts`'s `interpretDelivery`, pure
  and stateless: an `issues`/`pull_request` `labeled` event whose label is
  `agent:claude`/`agent:codex`/`agent:opencode` requests mode `implement`
  (issue or PR); the same on a PR with `review:claude`/`review:codex`/
  `review:opencode` requests mode `review`. Each delivery is evaluated on
  its own — there is no cross-check against the anchor's full current label
  set, no contradictory-multi-label detection, and no stale-label cleanup.
  What actually prevents two runs is `libs/orchestrator`'s per-task mutex:
  a request while a run is already live is refused (`task-busy`); a retried
  delivery (same GitHub delivery ID) maps back to the run it already
  created instead of starting a second one (`duplicate-request`). Your
  attempt identity, `$ATTEMPT_ID`, is `g<generation>:<intentId>`, where
  `intentId` is literally the orchestrator's run ID
  (`<repo>#<issue>/r<generation>`) — passed to your workflow as the
  `broker_intent_id`/`broker_generation` `workflow_dispatch` inputs by the
  orchestrator's outbox drain, not re-derived or re-verified by you.
- **Reply triggers:** `@claude`, `/codex`, `/opencode`/`/oc`, or the generic
  `@agent` (#573), matched by `orchestrator-ingest.ts`'s `matchReplyCommand`
  against an `issue_comment` `created` event from an `OWNER`/`MEMBER`
  author — anyone else's comment is ignored outright. The command must be
  the first token of the (whitespace-trimmed) comment body — not merely on
  its own line anywhere in a longer comment — followed by whitespace or
  end-of-string; trailing text after it is fine (`@claude please retry`),
  but a command appearing mid-comment does not count. There is no
  cross-check against the issue's current `agent:*` label: any recognized
  command at the top of a trusted reply requests that exact pipeline,
  live-run mutex permitting. **`@agent` is a fixed alias for `claude`**, not
  "whatever pipeline is currently labeled" — that resolve-from-label
  behavior belonged to the deleted dispatch-broker parser and has no
  replacement today. Always end a parking comment with the
  pipeline-specific trigger you actually want.

- **Bot login format:** `claude[bot]` (REST) / `app/claude` (GraphQL), and
  `agent-lcars[bot]` / `app/agent-lcars`, are the same App installations
  encoded two different ways depending on which GitHub API answered — see
  `docs/bot-identity-formats.md` for the full decision. REST shape is
  canonical here; never compare a `gh pr`/`issue list`/`view --json author`
  login straight against `AGENT_BOT_LOGINS` or `AGENT_FLEET_LOGIN` without
  normalizing it first.

## `agent:*` vs `review:*` on a pull request

Tagging an **issue** with `agent:claude`/`agent:codex`/`agent:opencode`
dispatches `mode: implement` (§Dispatch above). Tagging a **pull request**
with the same `agent:*` label dispatches `mode: implement` too (#567) —
take the PR over and keep pushing commits to its branch, same as an issue,
just against an existing branch instead of a new one. A pull request
tagged instead with `review:claude`/`review:codex`/`review:opencode`
dispatches `mode: review` — leave a review, don't push (#565/#568, revised
by #567 once the maintainer picked `review:*` as the dedicated review
trigger rather than overloading `agent:*` for both meanings). The two
label families are independent: a PR may carry `agent:*`, `review:*`,
both, or neither, and each drives its own dispatch mode when applied
(`libs/dispatch-contracts/src/pipelines.ts`'s
`AGENT_LABELS`/`REVIEW_LABELS`). `review:*` is not a
recognized label at all on a plain issue — there is no diff to review.

If you are dispatched with `mode: review` in the JSON brief at
`$AGENT_DISPATCH_CONTEXT`, the anchor is always a pull request and your job
is to **review its diff, not implement or push changes to it.** Read the
PR the way the built-in `review` skill would, then submit your findings as
a real GitHub pull request review (`gh pr review --comment`/
`--request-changes`/`--approve`, with a body) — not a plain issue comment.
This repo's deliverable-evidence gate (`verify-deliverable.sh`, per
agent-protocol.md §5) checks for exactly that: on a review dispatch, a
submitted PR review is the sanctioned deliverable, the same way a posted
comment is the sanctioned deliverable on a reply dispatch — but it must
carry your run's exact `<!-- attempt-claim:$ATTEMPT_ID -->` marker (#815:
the gate no longer accepts a bare review from your bot login on its own).
Stamp the marker in the review body. A takeover/progress comment alone does
not count.

If you are dispatched with `mode: implement` and the anchor is a pull
request (an `agent:*` label applied to it, not an issue), your job is to
**take the PR over and keep iterating on its own branch** — push commits
the normal way, same as any other implement dispatch. Pushing to the PR is
not, by itself, evidence any more (#815 retired the inference clause that
treated any push to the anchor PR as sufficient): stamp the exact
attempt-claim marker into the PR body, or post a comment on it carrying the
marker, before you finish.

The rest of the protocol still applies unchanged in either mode —
takeover comment, eyes reactions, one edited progress comment, parking on
a real blocker; a review dispatch pushes nothing (there is nothing to push
on a pure review).

The GitHub App subscribes to issue, issue-comment, and pull-request events.
`orchestrator-ingest.ts` acts only on the `labeled` action for both label
families (#565) and on `issue_comment`'s `created` action for reply
commands; `unlabeled`, `closed`, `reopened`, and any other action are
received but ignored today (`ignore('unhandled-action')` /
`ignore('unhandled-event')`) — there is no relabel/close-driven cleanup in
the current design. `verify-deliverable.sh` keeps the deliverable contract
aligned for both modes regardless of how the run was requested.

## Reconciliation and lease recovery

There is no ledger to reconcile today. `.github/workflows/dispatch-reconcile.yml`
calls `/api/control-plane/reconcile` every 30 minutes (also
`workflow_dispatch`-able); that handler is `Orchestrator.sweepExpired()`
(`libs/orchestrator/src/orchestrator.ts`) followed by an outbox drain
(`apps/console/src/lib/orchestrator-dispatch.ts`). What it actually does:

- **Lease expiry, not liveness polling.** A live run holds a 2-hour lease
  (`decide.ts`'s `LEASE_MS`) that only your own dispatch/report/renew calls
  extend. If your job dies silently — runner loss, a timeout with no
  completion callback, anything that never reaches `expireLease` on its
  own — the sweep is what eventually notices: once the lease is past due,
  the run is marked `lost` and the task's mutex is released. There is
  nothing for you to hand-repair here; you do not need to reconstruct or
  edit any state.
- **Bounded, automatic retry.** Immediately after marking a run `lost`, the
  sweep requests a fresh run for the same task with the same
  pipeline/params — unless the task has gone `lost` more than
  `MAX_AUTO_RETRIES` (2) times in a row since its last `finished`/
  `canceled` settlement, in which case it's left parked instead
  (`status:needs-human`, via the outcome comment the outbox drain posts).
  A manual reply/label request still works on a parked task at any time —
  it is not blocked by the exhausted auto-retry budget, only unattempted by
  the sweep itself.
- **The outbox drain also retries stuck deliveries.** A `dispatch-run` or
  `report-outcome` entry that failed a prior GitHub call (rate limit,
  transient 5xx) stays `pending` and is retried on the next drain — dispatch
  or completion, or this scheduled sweep, whichever runs next. This is why
  an outcome comment can appear on the issue noticeably after your run
  actually finished.

None of this involves a ledger comment, a `generation` counter, or a
Firestore authority lease on a shared document that a headless agent could
inspect or contend with directly — `libs/orchestrator/README.md` is the
whole contract if you need more than this summary.

## Auto-merge

`.github/workflows/agent-automerge.yml` squash-auto-merges any PR whose
author is listed in the `AGENT_BOT_LOGINS` repo variable (a JSON array —
currently `claude[bot]` and `agent-lcars[bot]`, covering claude.yml and the
OpenCode/Codex lanes respectively), gated only on the ruleset's required
`Verify` check. A new agent pipeline that follows this protocol (and
therefore opens its PRs under its own distinct bot identity) needs its login
appended to that variable to get auto-merge — never a change to the workflow
itself:

```bash
gh variable set AGENT_BOT_LOGINS --repo jlapenna/agent-lcars \
  --body '["claude[bot]","agent-lcars[bot]","<new-agent-login>"]'
```

## Verify before opening (or updating) a PR

No lcars delta — general dev guardrails (worktrees, hard limits) and the PR
and verify workflows now live once in the
[agent-lcars-dev](../agent-lcars-dev/SKILL.md) skill; read
[references/verify.md](../agent-lcars-dev/references/verify.md) before
ending your turn with a PR open.

## Hard limits specific to this repo

The universal limits (never `--no-verify`, never force-push without
`--force-with-lease`, and never edit `.github/workflows/*` without owner
permission) are in agent-protocol.md §11. That section also makes deployment
and IAM changes conditional on an explicit approval exception in trusted repo
policy. For this repo, direct deployment, Terraform-managed resource changes,
and direct Firestore writes are denied by default and require the named
maintainer's explicit approval for the specific operation and target, as
defined in
[agent-lcars-dev/SKILL.md](../agent-lcars-dev/SKILL.md#hard-guardrails).
Credential values remain absolutely prohibited in Terraform-managed files,
and the `supersprinklesracing` source-tree independence rule has no approval
exception.

## Session-resume script

This section is this repo's answer to the question agent-protocol.md §1
leaves to each repo's delta skill: which CLI (if any) has real
live-resume tooling here, and what its exact command looks like. The
console's takeover-command scanner expects a resume command containing the
literal substring `claude-agent-session.sh`. **`tools/claude-agent-session.sh`
exists in this repo.** What to post depends on which pipeline dispatched
you, because the script is Claude-specific — it discovers transcripts only
under `~/.claude/projects`, authenticates with `CLAUDE_CODE_OAUTH_TOKEN`,
and hands off to `claude --resume`. Only a `claude.yml` run's takeover
comment is exempt from agent-protocol.md §1's "no live-resume tooling"
default below — a `codex.yml` or `opencode.yml` run must follow that
default and never borrow this script's name.

**Dispatched by `claude.yml`:** post the real command.

```
tools/claude-agent-session.sh resume <session-id>
```

Find `<session-id>` the way agent-protocol.md §1 describes (the basename of
the newest `~/.claude/projects/<slugified-repo-path>/*.jsonl`).

**Dispatched by `codex.yml` or `opencode.yml`:** `tools/claude-agent-session.sh`
cannot resume either pipeline's session — it only knows Claude's transcript
format and authenticates with Claude's own OAuth token. Do not substitute a
differently-named script (agent-protocol.md §1's scanner matches the
literal `claude-agent-session.sh` and does not generalize per agent, so an
invented one would just be a dead command), and do not name
`claude-agent-session.sh`, or any other script, in the comment itself: it's
a Claude-only tool, and citing it from a Codex or OpenCode comment reads as
if that pipeline is confused about its own tooling, not as an honest gap
disclosure. Say plainly, in your own words, that no resume tooling exists
for your pipeline, then point the maintainer at the PR branch. That gap is
real and unclosed — naming the gap is the honest deliverable, not naming a
Claude script that doesn't apply to you.

The two pipelines' actual situations differ, and the comment should say so
accurately rather than treating "no resume tooling" as identical for both:

- **Codex:** there is no live-resume command, but the run's transcript IS
  archived to GCS once the job ends (`codex.yml`'s telemetry sidecar +
  `libs/telemetry/src/lib/codex-transcript-adapter.ts`), and the session's
  console page does show an "Archived transcript" note naming that
  `gs://` URI (`apps/console/src/app/sessions/[id]/session-header.tsx`) —
  but the console does not render the transcript's _contents_ there.
  `getSessionDetail` (`apps/console/src/lib/session-detail.ts`) only
  fetches and parses a transcript when `sessionAgent(doc) === 'claude-code'`,
  so a Codex session's page shows where the archive lives, never the
  transcript itself. Say the transcript is archived to GCS, not that it's
  "viewable in the console." If you want to hand the maintainer a real way
  to read it, `gcloud storage cat` on that `gs://` URI prints the raw
  JSONL directly — the same `gcloud storage` tool
  `tools/claude-agent-session.sh`'s own `resume-archive` uses to download
  it. No `resume-archive` equivalent exists for Codex today.
- **OpenCode:** nothing is archived at all. The telemetry sidecar's watch
  roots are `~/.claude/projects` and `~/.codex/sessions`
  (`apps/telemetry-watcher/src/lib/runner.ts`'s `startSidecar`) — OpenCode
  writes to neither, and no OpenCode transcript adapter exists
  (`libs/telemetry/src/lib/transcript-adapter.ts`'s `TRANSCRIPT_ADAPTERS`),
  so an OpenCode run ships no transcript and no session doc at all. There
  is nothing to point at beyond the PR branch.

This section used to say the script did not exist here at all, and stayed
that way long after it landed. Every pipeline's agents read it and posted
"resume tooling is not yet available" — which is exactly the string the
console's `TAKEOVER_COMMAND_RE` (`apps/console/src/lib/action-items.ts`)
cannot match, so the takeover affordance stayed dark on this repo's own
issues while working for every other repo the fleet watches. If you are
about to write that sentence as a `claude.yml` run, check `tools/` first.

The rest of this section applies to `claude.yml` runs. Two things are worth
putting in the takeover comment itself, because they change what the
maintainer can actually do:

- `resume` reaches a session only while its runner container is alive, and
  JIT runners are torn down at job end. `list` shows what is still live.
- After the run ends, the maintainer needs
  `tools/claude-agent-session.sh resume-archive <run-id>`, which restores
  the archived transcript from GCS and prints the `claude --resume` line
  for it. Worth naming in the comment, since by the time anyone reads a
  finished run's anchor, plain `resume` will no longer find it.

Mention `resume-archive` in _addition_ to the `resume` line, never instead
of it: `TAKEOVER_COMMAND_RE` is
`/(\S*claude-agent-session\.sh\s+resume\s+[\w-]+)/`, which requires
whitespace after `resume` and so does not match `resume-archive` at all. A
comment carrying only the archive form surfaces nothing in the console.
