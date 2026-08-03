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

## Workflows

Read the reference before starting the corresponding task:

| Workflow                          | When to use                                                    |
| --------------------------------- | -------------------------------------------------------------- |
| [pr.md](references/pr.md)         | Creating or updating a Pull Request.                           |
| [verify.md](references/verify.md) | Definition of Done — run before declaring any change complete. |

## Related Skills

Load these when the task enters their domain:

- **[agent-protocol](../agent-protocol/SKILL.md)** / **[lcars](../lcars/SKILL.md)**
  — headless CI dispatch conventions and this repo's own dispatch-broker,
  auto-merge, and identity delta. Not needed for ordinary interactive
  development.
