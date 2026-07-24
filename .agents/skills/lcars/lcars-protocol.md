# LCARS Protocol — `agent-lcars` Repo Delta

Repo-specific conventions for `jlapenna/agent-lcars`. This is a short delta
on top of `.agents/skills/agent-protocol/agent-protocol.md` — read that file
first; everything here just fills in the repo-specific parameters it leaves
open, plus a few hard limits unique to this repo. Where the two disagree,
this file wins for this repo.

This repo is unusual among consumers of the shared file: it's both a
consumer (see `.github/workflows/claude.yml` / `opencode.yml`) and, being
the fleet's own operations console, a **reader** of the conventions it
defines — `apps/console` parses the takeover command, the `human-needed`
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

- **Reply triggers:** `@claude` (claude.yml) on an issue already carrying
  the `claude` label, or directly on a pull request; `/opencode` or `/oc`
  (opencode.yml) on an issue carrying the `opencode` label. A plain reply
  with neither trigger is silently ignored — always end a parking comment
  with the correct one for whichever pipeline dispatched you.

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
  build contexts. Shared telemetry integration goes through the versioned
  standalone bundle, not a source-level dependency.
- Never write to this repo's Firestore database directly from an agent
  run; go through the application code paths the console itself uses.

## Session-resume script

Per agent-protocol.md §1, the console's takeover-command scanner expects a
resume command containing the literal substring `claude-agent-session.sh`.
**This repo does not have that script yet.** The `claude-agent-lcars`
runner registration itself is confirmed live as of issue #39 (a dispatched
`claude` label run executed on it end to end) — the remaining gap is only
the script, not the runner. Add `tools/claude-agent-session.sh` (mirroring
the private `members` repo's script of the same name, adapted to this
repo's runner-container layout); until it lands, a takeover comment posted
by this repo's agents can state that resume tooling is not yet available
rather than inventing a path that does not exist.
