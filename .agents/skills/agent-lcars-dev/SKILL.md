---
name: agent-lcars-dev
description: Developer toolkit and mandatory guardrails for the agent-lcars repo — worktree/checkout safety, creating and verifying pull requests, and repo-wide hard limits (Terraform, deploy, Firestore, cross-repo independence). Load it at the start of every session in this repo, even if the task seems generic, because it defines the mandatory guardrails for git and deployment. Headless CI behavior lives in agent-protocol; LCARS control-plane internals live in the situational lcars skill.
---

# Agent LCARS Dev Toolkit

Workflows and guardrails for developing on the `agent-lcars` repo (Nx/pnpm
monorepo, Node 26, pnpm 11).

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
  secret, verification, and task-scope rules below apply in both modes.

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

  **Clean up your own task checkout before reporting completion**, including
  when the task ends unmerged. Record its absolute path, owning primary and
  branch; stop your own watchers and servers; then follow the shared
  [worktree-hygiene workflow](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/worktree-hygiene/SKILL.md)
  through the [PR cleanup procedure](references/pr.md). Set an outside working
  directory on every cleanup exec call: an earlier shell's `cd` does not persist.
  Your own cwd is a condition to fix, not a reason to retain a completed
  checkout. Verify both its directory and Git registration are gone. Preserve
  foreign owners and every real refusal; use the shared authorized recovery
  procedure for unmerged work rather than calling it landed or discarding it.

- **Push early — the heavy gate runs on CI, not your workstation.** The
  pre-push hook runs the fast layer (`format:check`, affected
  `lint`/`typecheck`) locally; it deliberately does **not** run the
  whole-tree `test` or `build` targets — those are the expensive,
  whole-tree-scanning steps, and `.github/workflows/ci.yml`'s `Verify` job
  (a required check gating every merge) already re-runs the full
  `test typecheck build test-race --all` gate on the configured CI runner
  fleet (GitHub-hosted for fork PRs). Running that same gate again locally
  first just serializes your own workstation in front of a check that's
  going to happen anyway — push once the fast layer passes and let CI do
  the rest. **The one local build exception is an `apps/console`-affected
  push.** The hook always calls `tools/console-build-smoke.sh`, which runs
  the real production `@agent-lcars/console:bundle` build and
  `tools/console-standalone-smoke.sh` (isolated boot, traced-externals load,
  webhook HTTP 401 probe) whenever `apps/console` is affected. That build is
  intentional and Console-scoped; it neither makes the whole-tree `build`
  target a local step nor duplicates CI's `Verify` gate, and Nx caches it
  like any other task. Allow for that real build when publishing; use the
  supported worker control `LCARS_CONSOLE_BUILD_CPUS`
  ([apps/console/build-workers.cjs](../../../apps/console/build-workers.cjs))
  when selecting concurrency. Local publication does not require k3s CI
  resource admission, a supervisor or a storage quota. Never plan a
  Console-affected publication as "no local build". See
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
  _values_. The user's requested task authorizes the Terraform operations
  needed to complete it; do not require a second maintainer approval. Inspect
  the plan, keep its changes within the requested scope, and follow the owning
  executor workflow. Never put a real secret value in a file Terraform touches.

- **Use the owning deployment workflow.** The
  normal deployment path is `.github/workflows/deploy-console.yml` — it fires
  automatically off a green `CI` run on `main`. Complete deployment when the
  user's requested task requires it, using the owning workflow and its target
  and verification requirements. Do not require another maintainer approval
  or deploy unrelated services.

- **Prefer the application's Firestore code paths.** When the requested task
  requires direct data repair, keep writes within that scope and verify the
  result. Do not require another maintainer approval for necessary task work.

- **Keep this repo independent from the `supersprinklesracing` source
  tree.** No cross-repository source imports or shared build contexts.
  Shared telemetry integration goes through the runner image's build-time
  bake-in of `apps/telemetry-watcher`'s bundle
  (`apps/runner-autoscaler/runner-image/Dockerfile`), not a source-level
  dependency.

- **Issue ownership — the assignee field**: the assignee records whose
  court the ball is in, so agents and humans don't collide. `agent-lcars-bot` is
  this fleet's claim identity across every repo it works, not specific to
  `agent-lcars` (see the [lcars](../lcars/SKILL.md) skill).
  - A **human assignee** owns the issue — do not start work on it unless
    that human explicitly hands it off (adding an `agent:*` label or a
    recognized reply trigger IS that handoff).
  - **`agent-lcars-bot` assigned** means the agent fleet has claimed it. Before
    touching such an issue, check for a live QueueExecutor run or recent
    agent-session evidence; if neither exists the claim may be stale. Reconcile
    recent PRs and comments before taking over; assignment alone is not
    evidence that another session is still working.
  - **Interactive maintainer sessions** act on the user's request. Reading,
    triaging, or implementing explicitly requested work does not require a
    fleet assignment or takeover comment. A direct request from the owning
    maintainer is a handoff; do not ask them to repeat it through labels or
    assignees. Check live ownership before implementation to avoid collisions,
    but do not claim issues merely because you read them. This is an explicit
    exception to the personal github-issue-workflow claim/comment defaults.
  - **Headless LCARS dispatches** follow **agent-protocol**. The console owns
    the anchor claim and takeover; workers do not post a second takeover.
    The issue-workflow hook only runs when `LCARS_RUN_ID` or
    `AGENT_DISPATCH_CONTEXT` is nonempty. Generic `CI`, a non-TTY, and provider
    session IDs do not establish a fleet dispatch.
  - **Blocked on the maintainer?** In an interactive session, ask in the
    conversation. Headless workers use the agent-protocol parking contract.
  - **Filing an issue yourself** requires session attribution. An
    interactive session runs `gh` under the maintainer's login, so an issue
    it invents is authored by `jlapenna` with no label, no marker, and no
    comment distinguishing it from one he wrote by hand -- unlike a headless
    run (authored by `agent-lcars[bot]`) or a Quick Task (`intake:quick-task`
    plus the hidden request marker in
    [docs/quick-task-identity.md](../../../docs/quick-task-identity.md)).
    Name the session and its resume command in the body when the CLI supports
    one. Skipping it is how a maintainer finds work
    he never asked for under his own name: reconstructing who filed
    `supersprinklesracing/sprinkles#5267` took `/proc` ancestry, two agent
    rollout transcripts, and the timeline API to recover one line the body
    should have carried.
  - **Re-check a claimed issue before you finish, not only before you start.**
    A claim records your intent; it does not stop anyone else. #1686 lost a
    seven-task implementation that way: the issue was closed by someone else's
    PR hours before, and the collision only surfaced when a rebase hit a
    content conflict at the very end. The dispatched guardrail hook flags routing an
    already-closed issue, but it only sees `gh` commands -- a long
    implementation that does not touch `gh` for hours is invisible to it. So
    on any run of that length, re-read the issue before opening the PR:
    `gh issue view <N> --json state,stateReason` plus
    `gh pr list --state all --search "<N>"`. If it closed under you, do not
    rebase through the conflict -- diff against whatever merged and ship only
    what survives.
  - Agents only ever **add** assignees; removing one is a human act.

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

**Prove functionality with useful work.** During development, prefer real
issues or work items over fabricated work units for end-to-end proof. Follow
[the real-work proof guidance](../../../docs/testing-policy.md#development-proof-uses-real-work)
for selecting work and recording evidence; synthetic regression tests remain
appropriate for focused contracts and failure cases.

Read the reference before starting the corresponding task:

| Workflow                                    | When to use                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
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
