# Setup-invariant audit (#2033)

Audited revision: `b69f2e4c` (2026-09-21). This records where LCARS checks
each setup invariant, where that check belongs, and what moved.

## Rule

A check belongs where the state it protects is decided:

| Kind of state                                                                                          | Owner                                                                                     | Class         |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------- |
| Fixed when an artifact is built (binaries, versions, baked files, skills)                              | Image build or package install                                                            | build/install |
| Fixed per deployment, revision, worktree or session (env config, hooks dir, identity)                  | Startup, worktree setup, or session bootstrap. It completes before the thing is available | bootstrap     |
| Genuinely changing (authorization, ownership, leases, review holds, credential expiry, health, output) | The point of use                                                                          | runtime       |
| Install once, but execution can still fail                                                             | Setup plus runtime handling of the real failure                                           | split         |
| Re-proves something an earlier stage already guarantees                                                | Remove after the earlier guarantee is in place                                            | redundant     |

A missing installation is a setup defect. Setup must report it, not every
agent or job that runs afterwards. Runtime checks of genuinely dynamic state
stay, even though they passed once during setup.

## What changed in the #2033 PR

### Runner image: build-time gate replaces boot and dispatch probes

`apps/runner-autoscaler/runner-image/verify-image-invariants.sh` runs once,
as `runner`, at the end of the image build. The layer-1 skill install runs
just before it and now fails closed. Together they prove:

- Actions node20/node24 runtimes run. The build did not check this before;
  only boot did.
- Corepack pnpm runs offline.
- Java major version is 21 or newer. The build previously ran only
  `java --version`.
- The trusted OpenCode CLI runs and supports `--auto`.
- The action-archive cache is baked.
- `/usr/local/bin/lcars` is executable. Nothing checked this before.
- The image carries no `~/.codex/auth.json`. Before, only a per-Codex-run
  check caught this.
- Every layer-1 skill is installed in `/home/runner/.claude/skills`. Before,
  a per-dispatch copy only warned when a skill was missing.

Removed as redundant:

- `entrypoint.sh`'s six per-boot probes. The #468 rationale was host-mounted
  externals and possible container reuse; #1431 retired the first, and every
  job gets a fresh container from a content-addressed image.
- `direct-runner.sh`'s per-OpenCode-dispatch `-x` and `--auto` probes.
- `prepare-dispatch.sh`'s per-dispatch fail-soft skill copy. It now only
  digests what the image holds.

What still runs at runtime:

- run identity, brief shape, checkout-token fetch and refresh
- credential-mount readability and the Codex lease/SHA/login check
- heartbeats and outcome verification
- the consumer-boundary assertion, which depends on the target repo
- the Codex no-baked-auth check, kept as cheap defense in depth at a
  credential boundary

**Invalidation and reverification.** Any change to image content (base,
toolchain pins, OpenCode version, skills list or skill content) means a
rebuild, and every rebuild re-runs the gate. The only publisher
(`homelab/bin/publish-agent-lcars-images.sh`, see
[image-publish-routing.md](image-publish-routing.md)) builds this Dockerfile,
so no unverified image can be published. The gate and the removed probes
ship in the same image, so no deployed image lacks both.

**Evidence** (local build of `31fb5e83`, `docker build`):

- The gate printed all 11 `ok:` lines.
- Inside the built image, deleting a skill and planting
  `~/.codex/auth.json` makes the gate exit 1, naming both failures.
- A layer-1 source missing its `SKILL.md` makes the installer exit 1.
- Re-running install-skills and the gate is a no-op pass.
- The skills are present for `runner` at `HOME=/home/runner`.
- The retired probes cost 2.1 s per JIT boot in this image. Boot now
  reaches `run.sh` immediately (0.74 s from start to exit, unconfigured).
- `RUNNER_MODE=direct` still fails fast when the run identity is missing.

Tests: `verify-image-invariants.test.sh` (new, in CI), plus the updated
`toolchain-health.test.sh`, `direct-runner.test.sh` and
`prepare-dispatch.test.sh`.

### Console: static configuration validated at boot

`register()` now calls `validateStartupConfiguration()`
(`apps/console/src/lib/startup-configuration.ts`). Before, these were parsed
only when a request first touched them:

- the admitted/watched repository cross-check (a mismatch made every webhook
  return 500)
- the watched-repos JSON
- work grants
- the outcome-webhook map (malformed values silently disabled every Slack
  outcome delivery)

The request paths keep their own parsing, because that parsing also enforces
the values. A contract case validates the values committed in
`apps/console/apphosting.yaml`, so a malformed edit fails CI before a
rollout. Invalidation: a new revision re-runs `register()`.

What "fails the boot" means here was observed on the real standalone bundle.
With mismatched repository variables, Next.js logs `Failed to prepare
server ... AGENT_LCARS_CONTROL_PLANE_REPOSITORIES must exactly match
AGENT_LCARS_WATCHED_REPOS` and serves HTTP 500 on every route. The process
does not exit; this is the same mode as the existing #1731 identity check.
`deploy-console.yml`'s post-deploy verification sees a broken revision
immediately, instead of only a later webhook or outcome drain. The
pre-push standalone smoke (`tools/console-standalone-smoke.sh`) hit exactly
this failure until its env declared the two repository variables, and now
declares them.

### Worktree setup and agent protocol

- `tools/setup-worktree.sh` no longer sets the ineffective `HUSKY=0`, and
  now documents why the explicit hook regeneration stays. A no-op
  `pnpm install` ("Already up to date") skips `prepare`, so a repeated setup
  relies on the explicit step. Verified by deleting `.husky/_` and running a
  no-op install (hooks stayed missing), then running `setup-worktree.sh`
  twice (hooks installed both times).
- `agent-protocol.md` §12 no longer tells every dispatched worker to probe
  for `lcars` with `command -v`. The image gate guarantees it, and an
  erroring call is still tolerated. This applies only to dispatched
  workers; interactive sessions gain no obligations.

## Follow-ups (substantiated, not fixed here)

| Issue | Finding                                                                                                                                                                                | Class           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| #2035 | CI reinstalls Terraform and its providers, Node/pnpm, uv/Python 3.14 and Playwright on every job; also a dead LFS-hook repair and a stale path filter                                  | build/install   |
| #2036 | QueueExecutor re-reads preflighted config and re-pulls the image after the claim; silent concurrency fallback; `--check-config` gap                                                    | bootstrap/split |
| #2037 | Onboarding facts discovered only at dispatch or sweep: App install, fleet-login access, labels, runner-list scope, the repo-variable manifest, required checks vs ruleset              | bootstrap       |
| #2038 | Remaining lazily validated console config: App key, webhook secret, queue env, evidence bucket, audience default                                                                       | bootstrap       |
| #2039 | Nx native-binding sha256 on every `tools/nx` call; full dependency check on every push; LFS hook-content assert at install; bare worktrees run no hooks; Nx cache credential bootstrap | build/split     |
| #2040 | OpenCode SQLite migration on every OpenCode dispatch                                                                                                                                   | build/split     |
| #2031 | Consumer-repo guardrail calls fail open when fleet-tools is not installed (comment on the existing member-repo hook audit)                                                             | bootstrap       |

## Checks confirmed in the right place

- **Image build:** installers such as `install-opencode-release.sh`,
  `populate-action-archive-cache.sh` and `repair-node-tar.sh`, the Dockerfile
  smoke tests, and the control-plane image's `verify-runtime.sh`.
- **Startup:** the console identity validation, Go `--check-config`,
  `verifyCheckpointWritable`, and the direct-runner bind preflight.
- **Install:** `tools/setup-git-hooks.sh` verifies hook installation, and no
  commit or push hook re-checks it. Commit/push hooks check branch, worktree,
  content and LFS upload, which are dynamic.
- **Runtime, and it must stay:**
  - request authentication and authorization (signature, OIDC, run-token
    expiry, grants, `author_association`)
  - leases and heartbeats, the repair-generation cap, ghost/orphan sweeps,
    fleet coordinator gates, and Zod parsing on Firestore reads
  - auto-merge PR/check state
  - the `workflows` grant verification in `mint-agent-token`
  - the PostToolUse issue guardrail. It checks only dispatch env, the
    command, and live issue state; it does not check setup.
- **Periodic reconcilers of declared setup** (appropriate):
  `label-contract-audit.yml` and `configure-github-app-webhook.yml`.

## Not inspected (no claim of clean)

- Console UI components.
- `libs/work` and `libs/orchestrator` internals beyond grep.
- `scaler.go` beyond the image pull.
- `agent-automerge-reusable.yml` lines 480-600 and 900-1400 (grep only).
- Tools the workflows invoke: `sync-github-labels.mjs`,
  `configure-github-app-webhook.mjs`, `deploy-console-prebuilt.mjs`,
  `e2e-local.sh`, `session-pin-tick.ts`.
- `tools/e2e-runner/Dockerfile` beyond its header.
- Member-repository hook files, the installed global fleet-tools copy,
  Homegit, and repo-tools' own scripts. These are owned by #2031,
  jlapenna/homegit#82 and repo-tools respectively.

## Remaining verification gates

These cannot be completed from the PR:

1. **Rollout.** The image change takes effect only when the homelab
   publisher publishes a new `homelab-runner` image, which needs maintainer
   action.
   - After publishing, confirm one JIT job and one direct QueueExecutor run
     of each pipeline complete.
   - Confirm that a Claude dispatch's prepare output reports a non-empty
     `skills-digest`.
   - Until then, running containers use the old image, which carries its
     own old entrypoint and helpers, so the two versions never mix.
2. **Console.** The next App Hosting rollout runs the stricter boot. The
   committed config is covered by the contract test; any env value set
   outside `apphosting.yaml` is not.
3. **Fresh interactive session and a legitimate LCARS dispatch** (#2032).
   Nothing here changes interactive-session behavior. The protocol edit
   affects only dispatched workers, and should be observed in the first
   post-rollout dispatch.
4. **Cross-repository and offline-account items.** Workstation hook
   installation and the consumer guardrail belong to jlapenna/homegit#82
   and #2031. Offline accounts were not exercised.

### #2039 development-loop follow-up

Native-binding hashing and content validation now run in `postinstall` and the
idempotent worktree setup. `tools/nx` reads an install receipt; if its shared cache
was evicted, it uses Nx's direct-loading mode until setup restores the receipt.
Dependency checks in pre-push run only when dependency inputs differ from
`origin/main`; CI retains the full check. A CI contract executes the hook to
verify Git LFS forwarding and the dependency-change boundary, replacing the
install-time source-content assertion.

Bare-worktree hook coverage and workstation remote-cache credential bootstrap
remain shared-tooling/Homegit work. Homegit #82 is closed and describes
interactive guardrail convergence; its closure is not proof of either remaining
#2039 acceptance condition. Do not copy the repository's hooks into Homegit or
claim these external conditions are complete from this local change.
