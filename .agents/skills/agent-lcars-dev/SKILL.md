---
name: agent-lcars-dev
description: Developer toolkit and mandatory guardrails for the agent-lcars repo — worktree/checkout safety, creating and verifying pull requests, and repo-wide hard limits (Terraform, deploy, Firestore, cross-repo independence). Load it at the start of every session in this repo, even if the task seems generic, because it defines the mandatory guardrails for git and deployment. Headless CI behavior lives in agent-protocol; LCARS control-plane internals live in the situational lcars skill.
---

# Agent LCARS Dev Toolkit

Workflows and guardrails for developing on the `agent-lcars` repo (Nx/pnpm
monorepo, Node 24, pnpm 11).

> [!IMPORTANT]
> **Workflow Adherence.** Read [references/pr.md](references/pr.md) before
> opening or updating a pull request, and
> [references/verify.md](references/verify.md) before ending your turn with
> a change you believe is complete.

## Hard Guardrails

These override any default behavior:

- **Execution mode is a hard boundary.** Interactive maintainer sessions follow
  the user's request and use the conversation for progress and decisions.
  Autonomous-only claim, takeover, dispatch-marker, parking, provider-handoff,
  and status-cadence requirements must not be imposed on them, even when
  another skill links to the headless protocol. Only explicitly dispatched
  LCARS workers follow `agent-protocol`. Working in this repository, generic
  CI flags, and piped tool input do not establish a dispatch. Shared checkout,
  secret, verification, and operation-approval rules below apply in both modes.

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
  confirm the primary checkout is clean and on the base branch. Other sessions
  using the primary as their cwd do not block this narrow fast-forward; if it is unsafe to update, report that
  it remains behind rather than stashing, resetting, or switching branches.

- **Push early — the heavy gate runs on CI, not your workstation.** The
  pre-push hook only runs the fast layer (`format:check`, affected
  `lint`/`typecheck`) locally; it deliberately does **not** run `test` or
  `build` — those are the expensive, whole-tree-scanning steps, and
  `.github/workflows/ci.yml`'s `Verify` job (a required check gating every
  merge) already re-runs the full `test typecheck build test-race --all`
  gate on the configured CI runner fleet (GitHub-hosted for fork PRs). Running that
  same gate again locally first just serializes your own workstation in
  front of a check that's going to happen anyway — push once the fast
  layer passes and let CI do the rest. See
  [references/verify.md](references/verify.md#ci-delegation) for the full
  reasoning. **Local E2E is optional, never a delivery prerequisite.** CI's
  required E2E check selects affected console and harness changes. Run the
  slow local suite
  (`tools/e2e-local.sh`'s hermetic build + Firebase emulator startup) only
  when it helps reproduce or debug a specific failure; it is supplemental
  evidence, not a reason to delay a ready push.

- **Never commit credentials.** Runtime secrets belong in GCP Secret
  Manager and the host writer credential belongs in the encrypted homelab
  secret store. Terraform owns secret _containers_ here, never secret
  _values_. Terraform changes require explicit maintainer approval for the
  specific issue and operation; without that approval, do not add, remove,
  or restructure Terraform-managed resources. Never put a real secret value
  in a file Terraform touches.

- **Do not run `firebase deploy` (or any other direct deploy command) without
  explicit maintainer approval for that specific command and target.** The
  normal deployment path is `.github/workflows/deploy-console.yml` — it fires
  automatically off a green `CI` run on `main`. Without explicit approval,
  getting your PR merged is as far as your responsibility goes; do not try to
  push a deploy to make a change "live" faster.

- **Do not write to this repo's Firestore database directly without explicit
  maintainer approval for the specific operation.** Without that approval,
  go through the application code paths the console itself uses.

- **Keep this repo independent from the `supersprinklesracing` source
  tree.** No cross-repository source imports or shared build contexts.
  Shared telemetry integration goes through the runner image's build-time
  bake-in of `apps/telemetry-watcher`'s bundle
  (`apps/runner-autoscaler/runner-image/Dockerfile`), not a source-level
  dependency.

- **Issue ownership**: before implementing an issue, read
  [references/issue-work.md](references/issue-work.md) and check live ownership.
  A maintainer's direct request is a handoff for interactive work; do not impose
  headless claim or takeover requirements. Agents only add assignees; removing
  one is a human act. The reference also owns issue-creation attribution and
  the pre-delivery collision check.

- **Interactive session tmux title**: on a workstation, the moment a
  session's first action identifies which issue it's working (e.g.
  running `gh issue view`, or resuming one), pin the tmux window title so
  concurrently-running sessions are distinguishable at a glance:
  `tmux set-window-option -t "$TMUX_PANE" @user_title "<title>"`. Format:
  `1234 Description` — always show the root issue number, bare, no `#`.
  Update again if the active issue changes mid-session. Not applicable to
  CI-dispatched runs (no tmux pane). This is non-blocking observability
  guidance, not an authorization boundary: the issue-workflow hook must never
  halt work because a title is missing, stale, mismatched, or unreadable.

- **LCARS console visibility**: when the user asks for console session title
  or status updates, use
  [lcars-session-updates](../lcars-session-updates/SKILL.md). Interactive
  progress belongs in the conversation; headless status obligations belong in
  the dispatch protocol.

## Workflows

Before implementation, identify the requested outcome, its acceptance boundary,
and the relevant local quality requirements. Use [ARCHITECTURE.md](../../../ARCHITECTURE.md)
and the [documentation map](../../../docs/README.md) to retrieve their owners.
For harness, documentation, or skill maintenance, follow
[the harness maintenance workflow](../../../docs/harness-engineering.md).

**Prove functionality with useful work.** During development, prefer real
issues or work items over fabricated work units for end-to-end proof. Follow
[the real-work proof guidance](../../../docs/testing-policy.md#development-proof-uses-real-work)
for selecting work and recording evidence; synthetic regression tests remain
appropriate for focused contracts and failure cases.

Read the reference before starting the corresponding task:

| Workflow                                    | When to use                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [issue-work.md](references/issue-work.md)   | Inspecting, implementing, or filing GitHub issues.                                                   |
| [pr.md](references/pr.md)                   | Creating or updating a Pull Request.                                                                 |
| [verify.md](references/verify.md)           | Definition of Done — run before declaring any change complete.                                       |
| [stacked-prs.md](references/stacked-prs.md) | Multiple auto-merge-armed PRs racing a moving `main`, or a reviewed stacked chain ready to collapse. |

## Related Skills

Load these when the task enters their domain:

- **[agent-protocol](../agent-protocol/SKILL.md)** — complete headless CI
  behavior. **[lcars](../lcars/SKILL.md)** — situational dispatch/orchestrator,
  telemetry, and auto-merge implementation reference.
- **[verifying-console-session](../verifying-console-session/SKILL.md)** —
  capture and reuse a real authenticated LCARS browser session for approved
  production UI verification when hermetic E2E cannot prove the live auth or
  deployment path.
