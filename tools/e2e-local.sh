#!/usr/bin/env bash
#
# Runs an e2e project's Playwright suite directly on the host, with the same
# environment CI uses. The final Nx process runs through
# tools/e2e/run-hermetic.sh, which starts from an empty environment and an
# isolated temporary HOME so ambient credentials cannot reach test tooling.
#
# Why this exists: `nx run <project>:e2e` on a fresh checkout fails twice
# over, and neither failure names its real cause.
#
#   1. `.env.e2e` does not exist (it is gitignored), so the implementation
#      target's own
#      `dotenv -e .env.e2e --optional` wrapper loads nothing and the server
#      dies at runtime with `AGENT_LCARS_GITHUB_TOKEN not defined`.
#   2. NEXT_PUBLIC_FIREBASE_*/AUTH_SECRET must be real *process* env before
#      `next build` runs -- and that build happens inside the `e2e` target's
#      own `dependsOn` chain, BEFORE the dotenv-wrapped command that loads
#      `.env.e2e` ever starts. Next.js inlines NEXT_PUBLIC_* at build time
#      and Auth.js reads AUTH_SECRET during server init, so leaving these to
#      the file alone silently bakes in empty values.
#
# `tools/e2e-docker.sh` already solves both for the container path; CI solves
# both in its own workflow step. This is the missing third case: the plain
# host run. Values come from tools/e2e/ci.env in both places rather than
# being hardcoded here, so there is no second copy to drift.
#
# Usage:
#   tools/e2e-local.sh                   # emulator, whole suite
#   E2E_GREP='@smoke' tools/e2e-local.sh # emulator, scoped suite
#
# Deliberately takes no Playwright passthrough args. The `e2e` target sets
# forwardAllArgs:false, so nx:run-commands silently DROPS trailing args and
# runs the whole suite regardless -- the same trap tools/e2e-docker.sh
# guards against, after a scoped `--grep` that never reached Playwright
# rewrote unrelated specs' screenshot baselines (members#2448). Rather than
# reimplement that guard, this rejects them outright and points back at this
# same hermetic entrypoint with E2E_GREP.
#
# Concurrency: this and every other e2e-local run on the same host bind the
# same fixed Firebase-emulator/Next.js ports (see tools/kill-e2e-ports.sh), so
# two runs -- even from different worktrees of this repo -- fight over them
# instead of failing cleanly (agent-lcars#535). A host-level flock below
# rejects a second concurrent run outright rather than letting it corrupt the
# first one's in-flight suite.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${E2E_PROJECT:-@agent-lcars/console-e2e}"
HERMETIC_RUNNER="$ROOT/tools/e2e/run-hermetic.sh"
# Fixed and repo-specific (not per-worktree): every worktree of this repo
# binds the same host ports, so the lock must serialize across all of them,
# not just within one. Overridable only so this script's own tests can assert
# the locking behavior without fighting the real path.
LOCK_FILE="${E2E_LOCAL_LOCK_FILE:-/tmp/agent-lcars-e2e-local.lock}"

# Fail loudly instead of silently running everything - see the usage note.
if [ "$#" -gt 0 ]; then
  echo "tools/e2e-local.sh: refusing to drop arguments: $*" >&2
  echo "  The ':e2e-implementation' target sets forwardAllArgs:false, so nx would ignore" >&2
  echo "  them and run the entire suite instead of the subset you asked" >&2
  echo "  for. Scope the same hermetic entrypoint with E2E_GREP instead:" >&2
  echo "    E2E_GREP='@smoke' ./tools/e2e-local.sh" >&2
  exit 2
fi

if [ ! -x "$HERMETIC_RUNNER" ]; then
  echo "tools/e2e-local.sh: missing executable $HERMETIC_RUNNER" >&2
  exit 1
fi

# Take a non-blocking host-level lock before touching any port or starting
# any build. This wrapper documents supporting macOS and Windows Bash
# environments too (docs/e2e-security-boundary.md), where the stock shell is
# Bash 3.2 (no `{var}` dynamic fd allocation) and `flock` is not preinstalled
# -- so a fixed, low-numbered descriptor is used instead of `{LOCK_FD}`, and
# `flock` itself is checked explicitly rather than left to fail opaquely.
if ! command -v flock >/dev/null 2>&1; then
  echo "tools/e2e-local.sh: flock is required to guard against concurrent" >&2
  echo "  e2e-local runs, but is not on PATH. It ships in util-linux, which is" >&2
  echo "  virtually always preinstalled on Linux; on macOS install it via" >&2
  echo "  Homebrew's util-linux formula or the 'discoteq/discoteq/flock' tap" >&2
  echo "  ('brew tap discoteq/discoteq && brew install flock'); on Windows Git" >&2
  echo "  Bash/MSYS2, install util-linux through pacman, or run under WSL." >&2
  exit 1
fi

# Open in append mode so a losing attempt never truncates the winner's
# recorded pid out from under it -- only the confirmed holder (below)
# rewrites the file. `exec 9>>` opens the descriptor on the current shell
# (rather than a subshell), and the later `exec "$HERMETIC_RUNNER"` replaces
# this process without closing it, so the lock stays held for the entire
# run -- build, emulators, and Playwright -- and is only released when the
# whole descendant process tree exits and the kernel drops the last
# reference to it.
exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
  holder_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  echo "tools/e2e-local.sh: another e2e-local is running (pid ${holder_pid:-unknown})" >&2
  echo "  e2e-local runs bind fixed emulator/app ports and cannot run concurrently" >&2
  echo "  on one host, even from a different worktree. Wait for it to finish, or if" >&2
  echo "  pid ${holder_pid:-N} is dead, remove $LOCK_FILE and retry." >&2
  exit 1
fi
# Now the confirmed exclusive holder: record our pid for the next contender.
echo "$$" >"$LOCK_FILE"

# e2e-implementation is explicitly `cache: false`, so Nx always executes the
# suite rather than replaying an earlier green result. Do not add
# `--skip-nx-cache`: that broader switch would also prevent its deterministic
# dependency builds from restoring artifacts from L2.
exec "$HERMETIC_RUNNER" \
  pnpm exec nx run \
    "${PROJECT}:e2e-implementation:emulator"
