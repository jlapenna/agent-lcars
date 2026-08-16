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

- **Your attempt identity:** `$ATTEMPT_ID` is `g<generation>:<intentId>`,
  handed to your workflow by the orchestrator. You never derive, verify, or
  repair it. How dispatch decides to start you at all is in
  [`lcars-protocol-reference.md`](lcars-protocol-reference.md).

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

## Dispatch modes: what to actually do

The brief's `mode` field already tells you which of these you are in — you do
not need to inspect labels to find out.

| `mode`      | anchor       | your deliverable                                               |
| ----------- | ------------ | -------------------------------------------------------------- |
| `implement` | issue        | open a PR on a new branch                                      |
| `implement` | pull request | take the PR over and keep pushing to **its** branch (#567)     |
| `review`    | pull request | submit a real `gh pr review` with a body — push nothing (#565) |
| `reply`     | either       | a comment can be the whole deliverable                         |

On a `review` dispatch the deliverable is a submitted pull request review,
not a plain issue comment: `verify-deliverable.sh` looks for the review
object. On an `implement`-on-PR dispatch, pushing to the PR is not evidence
by itself — #815 retired that inference. Either way the artifact needs your
run's exact `<!-- attempt-claim:$ATTEMPT_ID -->` marker; the dispatch
workflow stamps it onto whatever PR or comment you create (#1213), so you do
not have to transcribe it, but do not strip it if you see it.

Everything else in the protocol applies unchanged in every mode: takeover
comment, eyes reactions, one edited progress comment, parking on a real
blocker. Which label families drive which mode, and which webhook actions
the ingest ignores, are in
[`lcars-protocol-reference.md`](lcars-protocol-reference.md).

## Reconciliation: nothing for you to repair

If your job dies silently, a 30-minute sweep notices the expired lease,
marks the run `lost`, releases the task mutex, and automatically retries
(up to 2 consecutive times, then parks with `status:needs-human`). There is
no ledger comment, no generation counter, and no shared document for you to
inspect, contend with, or hand-repair. The mechanism is in
[`lcars-protocol-reference.md`](lcars-protocol-reference.md);
`libs/orchestrator/README.md` is the full contract.

## Takeover comment: which handoff line to post

This is this repo's answer to the question agent-protocol.md §1 leaves to
each repo's delta. `tools/claude-agent-session.sh` **exists in this repo**
and is Claude-specific — it reads only `~/.claude/projects` transcripts and
authenticates with Claude's own OAuth token.

- **Dispatched by `claude.yml`:** post the real command, where `<session-id>`
  is the basename of the newest `~/.claude/projects/<slugified-repo-path>/*.jsonl`:

  ```
  tools/claude-agent-session.sh resume <session-id>
  ```

  Mention `tools/claude-agent-session.sh resume-archive <run-id>` **in
  addition**, never instead: plain `resume` only reaches a session while its
  JIT runner is alive, and by the time anyone reads a finished run's anchor
  it will not find it. The console's `TAKEOVER_COMMAND_RE` requires
  whitespace after `resume`, so `resume-archive` alone matches nothing.

- **Dispatched by `codex.yml` or `opencode.yml`:** take agent-protocol.md
  §1's "no live-resume tooling" default. Say so plainly in your own words and
  point the maintainer at the PR branch. Do **not** name
  `claude-agent-session.sh` or invent a differently-named script — the gap is
  real, and naming it is the honest deliverable. For Codex you may add that
  the transcript is archived to GCS (readable with `gcloud storage cat`, not
  viewable in the console); for OpenCode nothing is archived at all.

Why each pipeline's situation is what it is — and the incident where this
section's staleness kept the takeover affordance dark on this repo's own
issues — is in
[`lcars-protocol-reference.md`](lcars-protocol-reference.md).

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
