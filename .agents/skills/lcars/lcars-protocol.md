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

- **Dispatch:** the serialized dispatch broker
  (`.github/actions/dispatch-broker/normalize.mjs`, invoked from
  `agent-router.yml`) normalizes every trigger into an intent for exactly one
  of `claude.yml`, `codex.yml`, or `opencode.yml`. There is no precedence
  order and no pipeline "stands down": an issue carrying more than one
  `agent:*` label makes the broker throw a contradictory-agent-labels error
  instead of picking a winner, and a comment matching more than one
  recognized command is rejected outright — not dispatched at all — rather
  than resolved in favor of one pipeline (`parseExactCommand` in
  `normalize.mjs`). One narrow self-heal exception: a `labeled` event whose
  own label disambiguates against exactly one other stale `agent:*` label
  (the transient window a manual GitHub UI relabel opens) makes the newest
  label win, removing the stale one via the API with ledger evidence before
  dispatching — comment-path ambiguity, three or more coexisting labels, and
  a label missing from the current issue snapshot still throw.
- **Reply triggers:** `@claude`, `/codex`, `/opencode`/`/oc`, or the generic
  `@agent` (#573), but only when the command is the sole first token of its
  own line (trailing text after it is fine, e.g. `@claude please retry`); a
  command embedded mid-prose, inside a fenced code block, or on a quoted
  (`>`) line does not count (`parseExactCommand` in `normalize.mjs`). The
  pipeline-specific commands' pipeline must match the issue's single
  selected `agent:*` label — except `@claude` on a pull request, which
  dispatches regardless of label. `@agent` names no pipeline at all; it
  resolves to whatever that single selected label already is, and fails
  closed (no dispatch) if the label is absent or ambiguous — it does not
  get the pull-request default `@claude` gets. A plain reply with no
  recognized command, or a comment carrying more than one, is silently
  ignored — always end a parking comment with the correct trigger for
  whichever pipeline dispatched you (`@agent` is always safe there too,
  since it reads back the same label you were dispatched under).

- **Bot login format:** `claude[bot]` (REST) / `app/claude` (GraphQL), and
  `agent-lcars[bot]` / `app/agent-lcars`, are the same App installations
  encoded two different ways depending on which GitHub API answered — see
  `docs/bot-identity-formats.md` for the full decision. REST shape is
  canonical here; never compare a `gh pr`/`issue list`/`view --json author`
  login straight against `AGENT_BOT_LOGINS` or `AGENT_FLEET_LOGIN` without
  normalizing it first.

## Review mode — the same `agent:*` label, applied to a pull request

Tagging an **issue** with `agent:claude`/`agent:codex`/`agent:opencode`
dispatches `mode: implement` (§Dispatch above). Tagging a **pull request**
with the same label dispatches `mode: review` instead — GitHub delivers a
PR's own `labeled`/`unlabeled` action as a `pull_request` webhook event,
never an `issues` event, so `normalize.mjs` can tell the two apart from the
event's own shape alone and doesn't need a distinct label per mode. No new
label exists or is planned for this — reuse the existing three.

If you are dispatched with `mode: review` in the JSON brief at
`$AGENT_DISPATCH_CONTEXT`, the anchor is always a pull request and your job
is to **review its diff, not implement or push changes to it.** Read the
PR the way the built-in `review` skill would, then submit your findings as
a real GitHub pull request review (`gh pr review --comment`/
`--request-changes`/`--approve`, with a body) — not a plain issue comment.
This repo's deliverable-evidence gate (`verify-deliverable.sh`, per
agent-protocol.md §5) checks for exactly that: on a review dispatch, a
submitted PR review from your own bot login is the sanctioned deliverable,
the same way a posted comment is the sanctioned deliverable on a reply
dispatch. A takeover/progress comment alone does not count. The rest of the
protocol still applies unchanged — takeover comment, eyes reactions, one
edited progress comment, parking on a real blocker, pushing nothing (there
is nothing to push on a pure review).

**Known gap (#565):** this dispatch path only fires once
`.github/workflows/agent-router.yml`'s own `pull_request:` trigger listens
for `labeled`/`unlabeled` in addition to its current `[closed, reopened]` —
a `.github/workflows/*` edit, which AGENTS.md's hard limits reserve for a
repository owner's explicit permission. Everything upstream of that one
trigger line (`normalize.mjs`, `main.mjs`'s timeline fetch,
`verify-deliverable.sh`) is already wired and tested; only the workflow
subscription itself is outstanding.

## Dispatch ledger reconciliation

`.github/workflows/dispatch-reconcile.yml` runs every 30 minutes (offset
from :00/:30, cron `7,37 * * * *`) and on manual `workflow_dispatch`. Its own
job is read-only discovery: it lists every currently open issue/PR carrying
an `agent:*` label, unioned with every open issue/PR assigned to
`vars.AGENT_FLEET_LOGIN` (`jclaw-bot`) — the durable, label-independent
signal `claim-issue` already sets at the start of every worker dispatch and
never clears, which is what still finds a ledger whose last `agent:*` label
was removed while its generation was active (`main.mjs`'s
`discoverReconcileCandidates`) — then fires one `workflow_dispatch`
`kind: reconcile` call at `agent-router.yml` per candidate (`scanReconcile` /
`dispatchReconcileScan`). It never touches a ledger comment itself — every
actual repair happens inside the exact same per-issue serialized broker job
every other trigger already goes through (the reserved
`agent-lcars-dispatch-v1-<repositoryId>-<issue>` concurrency group, #349's
indirect concurrency corroboration for workflow_dispatch-triggered runs, and
the usual fail-closed → `status:needs-human` + maintainer parking path). See
`.github/actions/dispatch-broker/main.mjs`'s `reconcileLedger` and
`trackMissingRun` for the pure repair logic and
`.github/actions/dispatch-broker/main.test.mjs` for its interruption/
idempotency test coverage.

What it repairs, reusing the broker's own existing machinery wherever
possible:

- **Completion observations lost to a red or crashed run** (a pre-#349 red
  broker run, a worker timeout, or a force-cancel that skipped the
  completion callback): `reconcileActive()` — already run on every event —
  re-fetches the bound worker run's live status and applies the same
  idempotent `completeRun` transition the callback would have, whenever it
  finds the run is actually terminal.
- **A dispatch whose outcome was genuinely lost** (a queue-evicted intent
  #345/#347 deliberately failed red for, or a worker that crashed before any
  run ever registered): a generation stuck `dispatching`/`dispatch-unknown`
  with no matching run gets a bounded number of interval-separated
  observations (`reconcile-missing-run` anomalies, evidence recorded in the
  ledger every time) before parking `status:needs-human` at the bound
  (`reconcile-parked`). A generation still within its grace period, or
  re-observed sooner than the minimum interval, is a silent no-op — this is
  what makes overlapping/duplicate scans idempotent.
- **Stale pending intents**: queued behind either repair above, they are
  promoted and (re-)dispatched automatically the moment their blocking
  generation resolves (`completeRun`'s existing promotion, followed by
  `dispatchAccepted()`) — there is no separate "stale pending" mechanism.
- **Concurrent duplicate attempts**: `reconcileActive()` already records a
  `duplicate-attempt` anomaly naming every matching run and fails closed
  (parked, never silently resolved or auto-canceled) the moment more than
  one worker run matches a single dispatch generation.

Out of scope for this pass (documented, not silently dropped): closed/merged
anchors, cross-repository discovery, and a run that is genuinely still
in-progress well past its worker timeout — the worker's own
`timeout-minutes` bound already forces those to a terminal GitHub Actions
conclusion well inside any reasonable reconcile cadence.

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
`--force-with-lease`, never edit `.github/workflows/*`, never deploy, never
touch IAM) are agent-protocol.md §11; the canonical statement of this
repo's own additions (never touch `infra/terraform`, never run `firebase
deploy` yourself, keep this repo independent from the
`supersprinklesracing` source tree, never write to Firestore directly) is
[agent-lcars-dev/SKILL.md](../agent-lcars-dev/SKILL.md#hard-guardrails),
restated there so headless runbooks and prompts have one place to point to
without loading the full skill.

## Session-resume script

Per agent-protocol.md §1, the console's takeover-command scanner expects a
resume command containing the literal substring `claude-agent-session.sh`.
**`tools/claude-agent-session.sh` exists in this repo.** What to post
depends on which pipeline dispatched you, because the script is
Claude-specific — it discovers transcripts only under
`~/.claude/projects`, authenticates with `CLAUDE_CODE_OAUTH_TOKEN`, and
hands off to `claude --resume`.

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
