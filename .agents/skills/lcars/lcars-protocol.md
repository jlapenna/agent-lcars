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
  `normalize.mjs`).
- **Reply triggers:** `@claude`, `/codex`, or `/opencode`/`/oc`, but only
  when the command is the sole first token of its own line (trailing text
  after it is fine, e.g. `@claude please retry`); a command embedded
  mid-prose, inside a fenced code block, or on a quoted (`>`) line does not
  count (`parseExactCommand` in `normalize.mjs`). The command's pipeline
  must match the issue's single selected `agent:*` label — except `@claude`
  on a pull request, which dispatches regardless of label. A plain reply
  with no recognized command, or a comment carrying more than one, is
  silently ignored — always end a parking comment with the correct trigger
  for whichever pipeline dispatched you.

- **Bot login format:** `claude[bot]` (REST) / `app/claude` (GraphQL), and
  `agent-lcars[bot]` / `app/agent-lcars`, are the same App installations
  encoded two different ways depending on which GitHub API answered — see
  `docs/bot-identity-formats.md` for the full decision. REST shape is
  canonical here; never compare a `gh pr`/`issue list`/`view --json author`
  login straight against `AGENT_BOT_LOGINS` or `AGENT_FLEET_LOGIN` without
  normalizing it first.

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

This is an Nx/pnpm monorepo (Node 24, pnpm 10). Before ending your turn with
a PR open:

```bash
pnpm check:dependencies    # lockfile / workspace-mandate integrity
pnpm format:check          # prettier, nx format:check --all
pnpm lint                  # nx run-many -t lint --all
pnpm lint:circular          # madge circular-dependency check
pnpm exec nx run-many -t test typecheck build --all
```

Or run the composite `pnpm verify`, which chains the above (minus
`check:dependencies`). These are the same checks CI runs in
`.github/workflows/ci.yml` — match them locally before pushing so your own
push doesn't just trade a slow feedback loop for CI's.

`pnpm verify` does **not** run the console e2e suite. When a change touches
anything the dashboard renders or fetches — `apps/console/src/lib`, a Server
Action, the e2e GitHub fixture — run it too:

```bash
pnpm exec nx run @agent-lcars/console-e2e:e2e-local
```

Use that target, not `:e2e` directly. It sets up the same environment CI's
"Prepare E2E environment" step does (materializing `.env.e2e` from
`tools/e2e/ci.env` without clobbering a customized one, and exporting the
`NEXT_PUBLIC_*`/`AUTH_SECRET` values that must exist _before_ the
`dependsOn` build inlines them). Run bare, `:e2e` fails on a fresh checkout
with `AGENT_LCARS_GITHUB_TOKEN not defined`, which names neither cause.

It also passes `--skip-nx-cache`, deliberately: an e2e result replayed from
the Nx cache reports a green suite that never ran, which is worse than
useless when the suite is the thing you are trying to trust. For screenshot
work use `:e2e-docker` instead, which pins the rendering environment.

To scope a run, drive Playwright directly — `:e2e` sets
`forwardAllArgs: false`, so trailing args passed to it are silently dropped
and the whole suite runs anyway:

```bash
pnpm exec nx run @agent-lcars/console-e2e:e2e-run --grep @smoke
```

## Hard limits specific to this repo

These are additive to agent-protocol.md §11, not a relaxation of it:

- **Never touch `infra/terraform`.** Per `AGENTS.md`: Terraform owns secret
  _containers_ here, never secret _values_ — do not add, remove, or
  restructure Terraform-managed resources, and never put a real secret
  value in a file Terraform touches.
- **Never run `firebase deploy` (or any other direct deploy command)
  yourself.** Deployment is `.github/workflows/deploy-console.yml`'s job —
  it fires automatically off a green `CI` run on `main`. Getting your PR
  merged is as far as your responsibility goes; do not try to push a
  deploy to make a change "live" faster.
- **Keep this repo independent from the `supersprinklesracing` source
  tree** (per `AGENTS.md`): no cross-repository source imports or shared
  build contexts. Shared telemetry integration goes through the runner
  image's build-time bake-in of `apps/telemetry-watcher`'s bundle
  (`apps/runner-autoscaler/runner-image/Dockerfile`), not a source-level
  dependency — the earlier versioned-standalone-bundle-on-GCS scheme this
  used to describe was retired for good in #66.
- Never write to this repo's Firestore database directly from an agent
  run; go through the application code paths the console itself uses.

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

**Dispatched by `codex.yml` or `opencode.yml`:** this script cannot resume
your session, and `opencode.yml` archives no transcript at all. Say plainly
that no resume tooling exists for your pipeline rather than pasting a
command that will fail for the maintainer — and do not substitute a
differently-named script, since agent-protocol.md §1's scanner matches the
literal `claude-agent-session.sh` and does not generalize per agent. That
gap is real and unclosed; naming it in your comment is the honest
deliverable here.

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
