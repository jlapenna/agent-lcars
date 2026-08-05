---
name: agent-lcars-dev
description: Developer toolkit and mandatory guardrails for the agent-lcars repo — worktree/checkout safety, creating and verifying pull requests, and repo-wide hard limits (Terraform, deploy, Firestore, cross-repo independence). Load it at the start of every session in this repo, even if the task seems generic, because it defines the mandatory guardrails for git and deployment. Headless CI dispatch conventions (takeover comment, parking, identity, dispatch ledger) live in the agent-protocol and lcars skills instead.
---

# Agent LCARS Dev Toolkit

Workflows and guardrails for developing on the `agent-lcars` repo (Nx/pnpm
monorepo, Node 24, pnpm 10).

> [!IMPORTANT]
> **Workflow Adherence.** Read [references/pr.md](references/pr.md) before
> opening or updating a pull request, and
> [references/verify.md](references/verify.md) before ending your turn with
> a change you believe is complete.

## Hard Guardrails

These override any default behavior:

- **Checkout safety — worktrees are mandatory, not optional**: the primary
  checkout is shared state and reserved for a clean `main`. Before editing
  files or running a git-mutating command (`branch`, `commit`, `push`,
  `checkout`, `stash`, `reset`, or a merge), create a dedicated feature
  worktree from the current remote base:

  ```bash
  git fetch origin
  git worktree add ../agent-lcars-<task> -b <branch> origin/main
  cd ../agent-lcars-<task>
  ./tools/setup-worktree.sh
  ```

  Apart from fetching, creating a worktree, and a fast-forward-only sync of
  its clean `main` after a merge, only read-only inspection is allowed in
  the primary checkout. Never switch the primary checkout to a feature
  branch, and never use `--no-verify` to bypass commit or push hooks — the
  hooks reject commits and pushes from `main` and from the primary checkout
  as a second line of defense.

  After merging and safely removing the feature worktree, sync the primary
  checkout to the latest remote base with a fast-forward-only pull. First
  confirm the primary checkout is clean, on the base branch, and not being
  used by another session; if it is unsafe to update, fetch and report that
  it remains behind rather than stashing, resetting, or switching branches.

- **Push early — the heavy gate runs on CI, not your workstation.** The
  pre-push hook only runs the fast layer (`format:check`, affected
  `lint`/`typecheck`) locally; it deliberately does **not** run `test` or
  `build` — those are the expensive, whole-tree-scanning steps, and
  `.github/workflows/ci.yml`'s `Verify` job (a required check gating every
  merge) already re-runs the full `test typecheck build test-race --all`
  gate on its own GitHub-hosted runner the moment you push. Running that
  same gate again locally first just serializes your own workstation in
  front of a check that's going to happen anyway — push once the fast
  layer passes and let CI do the rest. See
  [references/verify.md](references/verify.md#ci-delegation) for the full
  reasoning. Don't wait on the slow local E2E suite
  (`tools/e2e-local.sh`'s hermetic build + Firebase emulator startup)
  either — let it run concurrently with CI as an independent second
  confirmation instead of serializing after it; report the pushed SHA
  right away and the local suite's result in a follow-up.

- **Never commit credentials.** Runtime secrets belong in GCP Secret
  Manager and the host writer credential belongs in the encrypted homelab
  secret store. Terraform owns secret _containers_ here, never secret
  _values_ — do not add, remove, or restructure Terraform-managed
  resources, and never put a real secret value in a file Terraform
  touches. **Never touch `infra/terraform`** beyond that.

- **Never run `firebase deploy` (or any other direct deploy command)
  yourself.** Deployment is `.github/workflows/deploy-console.yml`'s job —
  it fires automatically off a green `CI` run on `main`. Getting your PR
  merged is as far as your responsibility goes; do not try to push a
  deploy to make a change "live" faster.

- **Never write to this repo's Firestore database directly** from an agent
  run — go through the application code paths the console itself uses.

- **Keep this repo independent from the `supersprinklesracing` source
  tree.** No cross-repository source imports or shared build contexts.
  Shared telemetry integration goes through the runner image's build-time
  bake-in of `apps/telemetry-watcher`'s bundle
  (`apps/runner-autoscaler/runner-image/Dockerfile`), not a source-level
  dependency.

- **Issue ownership — the assignee field**: the assignee records whose
  court the ball is in, so agents and humans don't collide. `jclaw-bot` is
  this fleet's claim identity across every repo it works, not specific to
  `agent-lcars` (see the [lcars](../lcars/SKILL.md) skill).
  - A **human assignee** owns the issue — do not start work on it unless
    that human explicitly hands it off (adding an `agent:*` label or a
    recognized reply trigger IS that handoff).
  - **`jclaw-bot` assigned** means the agent fleet has claimed it. Before
    touching such an issue, check for a live `claude.yml`/`codex.yml`/
    `opencode.yml` run or a recent agent session comment; if neither
    exists the claim is stale — take over and say so in an issue comment.
  - **Claim before you start**: when beginning work on an issue from an
    interactive session, run `gh issue edit <N> --add-assignee jclaw-bot`
    AND post a session takeover comment on the issue (name the resume
    command if your CLI supports one, mirroring the format the
    [lcars](../lcars/SKILL.md) skill's headless delta uses) — the claim
    says _the fleet_ has it; the comment says _which session_ owns the
    claim. Never `--add-assignee @me`: interactively that assigns the
    maintainer (you act under their login), and in CI the bot app
    identity is not assignable — GitHub silently drops it.
  - **Blocked on the maintainer?** Add them alongside the label:
    `gh issue edit <N> --add-label status:needs-human --add-assignee jlapenna`.
  - Agents only ever **add** assignees; removing one is a human act.

- **Interactive session tmux title**: on a workstation, the moment a
  session's first action identifies which issue it's working (e.g.
  running `gh issue view`, or resuming one), pin the tmux window title so
  concurrently-running sessions are distinguishable at a glance:
  `tmux set-window-option -t "$TMUX_PANE" @user_title "<title>"`. Format:
  `1234 Description` — always show the root issue number, bare, no `#`.
  Update again if the active issue changes mid-session. Not applicable to
  CI-dispatched runs (no tmux pane).

## Workflows

Read the reference before starting the corresponding task:

| Workflow                                    | When to use                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [pr.md](references/pr.md)                   | Creating or updating a Pull Request.                                                                 |
| [verify.md](references/verify.md)           | Definition of Done — run before declaring any change complete.                                       |
| [stacked-prs.md](references/stacked-prs.md) | Multiple auto-merge-armed PRs racing a moving `main`, or a reviewed stacked chain ready to collapse. |

## Related Skills

Load these when the task enters their domain:

- **[agent-protocol](../agent-protocol/SKILL.md)** / **[lcars](../lcars/SKILL.md)**
  — headless CI dispatch conventions and this repo's own dispatch-broker,
  auto-merge, and identity delta. Not needed for ordinary interactive
  development.
