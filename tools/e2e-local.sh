#!/usr/bin/env bash
#
# Runs an e2e project's Playwright suite directly on the host, with the same
# environment CI uses. The final Nx process starts from an empty environment
# and an isolated temporary HOME so ambient credentials cannot reach test
# tooling.
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
# (rather than a subshell), so it stays held for the entire run -- build,
# emulators, and Playwright -- and is only released when this process exits.
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

# Hermetic environment boundary. This deliberately sits after the host-level
# lock above: the lock must be held while this script creates its isolated
# HOME, builds the application, runs the emulators, and executes Playwright.
CI_ENV="$ROOT/tools/e2e/ci.env"
VALIDATOR="$ROOT/tools/e2e/validate-env.mjs"
CALLER_HOME="${HOME:-}"
PLATFORM="$(uname -s)"

if [ ! -f "$CI_ENV" ]; then
  echo "e2e-hermetic: missing $CI_ENV" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "e2e-hermetic: node is not available on PATH" >&2
  exit 1
fi

TEMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/agent-lcars-e2e-home.XXXXXX")"
CHILD_PID=""
cleanup() {
  rm -rf "$TEMP_HOME"
}
forward_termination() {
  local signal="$1"

  # `env` is run in the background below so this shell can clean up its
  # temporary HOME after the child exits. Forward direct termination signals
  # first; otherwise the child can outlive this process with its HOME removed
  # and a stale e2e-local pid in the host lock file.
  if [ -n "$CHILD_PID" ]; then
    kill "-$signal" "$CHILD_PID" 2>/dev/null || true
    if ! wait "$CHILD_PID"; then
      :
    fi
    CHILD_PID=""
  fi

  case "$signal" in
    HUP) exit 129 ;;
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
}
trap cleanup EXIT
trap 'forward_termination HUP' HUP
trap 'forward_termination INT' INT
trap 'forward_termination TERM' TERM
mkdir -p "$TEMP_HOME/tmp"

# Reads one KEY="value" entry from the checked-in emulator-only fixture.
ci_env_value() {
  local line
  line="$(grep -m1 "^${1}=" "$CI_ENV" || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

BUILD_ENV=()
for key in \
  AUTH_SECRET \
  NEXT_PUBLIC_FIREBASE_API_KEY \
  NEXT_PUBLIC_FIREBASE_APP_ID \
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST \
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
  NEXT_PUBLIC_FIREBASE_PROJECT_ID \
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET; do
  value="$(ci_env_value "$key")"
  if [ -z "$value" ]; then
    echo "e2e-hermetic: $key missing from tools/e2e/ci.env" >&2
    exit 1
  fi
  BUILD_ENV+=("$key=$value")
done

SAFE_ENV=(
  "PATH=$PATH"
  "HOME=$TEMP_HOME"
  "USER=e2e"
  "LOGNAME=e2e"
  "SHELL=${SHELL:-/bin/bash}"
  "LANG=${LANG:-C.UTF-8}"
  "TMPDIR=$TEMP_HOME/tmp"
  "NX_DAEMON=false"
  "NX_LOAD_DOT_ENV_FILES=false"
  "E2E_HERMETIC=1"
  "NODE_OPTIONS=--max-old-space-size=6144"
  "E2E_ENV_FILE=$CI_ENV"
  "E2E_ENV_LOCAL_FILE=$TEMP_HOME/.env.e2e.local"
)

case "${CI:-}" in
  1 | true) SAFE_ENV+=("CI=1") ;;
esac

# Corepack and Firebase normally store downloaded tooling below HOME. Point
# only those caches at their conventional durable locations so an isolated HOME
# does not force network downloads on every run (or break offline runs). Do not
# preserve ambient cache overrides: they could widen the filesystem paths
# admitted through this boundary.
if [ -n "$CALLER_HOME" ]; then
  case "$PLATFORM" in
    CYGWIN* | MINGW* | MSYS*)
      corepack_cache="$CALLER_HOME/AppData/Local/node/corepack"
      ;;
    *) corepack_cache="$CALLER_HOME/.cache/node/corepack" ;;
  esac
  SAFE_ENV+=(
    "COREPACK_HOME=$corepack_cache"
    "FIREBASE_EMULATORS_PATH=$CALLER_HOME/.cache/firebase/emulators"
  )
fi

# These are deliberate, non-credential inputs to Playwright. Boolean controls
# only have meaning when set to exactly 1; E2E_GREP is the supported way to
# scope a host run because the public Nx target cannot forward CLI arguments.
for key in SKIP_VISUAL VISUAL_ONLY UPDATE_SNAPSHOTS; do
  value="${!key-}"
  if [ "$value" = "1" ]; then
    SAFE_ENV+=("$key=1")
  fi
done
if [ -n "${E2E_GREP:-}" ]; then
  SAFE_ENV+=("E2E_GREP=$E2E_GREP")
fi

# The E2E target itself is deliberately uncached: replaying a green test run
# would mean the suite never actually exercised the app. Its dependency graph
# includes a separately invoked, deterministic console bundle, though, and
# that build is safe and valuable to share through L2. Admit only the complete
# remote-cache capability pair; no other caller credentials cross this
# hermetic boundary.
if [ -n "${NX_SELF_HOSTED_REMOTE_CACHE_SERVER:-}" ] && \
  [ -n "${NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN:-}" ]; then
  SAFE_ENV+=(
    "NX_SELF_HOSTED_REMOTE_CACHE_SERVER=$NX_SELF_HOSTED_REMOTE_CACHE_SERVER"
    "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=$NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN"
  )
fi

# Playwright normally installs browsers below the caller's HOME. Preserve only
# that cache location while replacing HOME itself; no other caller state crosses
# the boundary.
if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  SAFE_ENV+=("PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH")
elif [ -n "$CALLER_HOME" ]; then
  case "$PLATFORM" in
    Darwin) browser_cache="$CALLER_HOME/Library/Caches/ms-playwright" ;;
    CYGWIN* | MINGW* | MSYS*)
      browser_cache="$CALLER_HOME/AppData/Local/ms-playwright"
      ;;
    *) browser_cache="$CALLER_HOME/.cache/ms-playwright" ;;
  esac
  if [ -d "$browser_cache" ]; then
    SAFE_ENV+=("PLAYWRIGHT_BROWSERS_PATH=$browser_cache")
  fi
fi

if [ -n "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ]; then
  SAFE_ENV+=(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
  )
fi

# Validate under the same empty environment so even the guard process cannot
# inherit provider credentials. The target validates again immediately before
# dotenv loads its files, protecting direct target invocations too.
env -i "${SAFE_ENV[@]}" "${BUILD_ENV[@]}" \
  "$NODE_BIN" "$VALIDATOR" --require-hermetic \
  --next-root "$ROOT/apps/console" "$CI_ENV"

# Run the child in its own subshell so it does not inherit our lock descriptor:
# this parent keeps the lock until it has observed child exit, including after a
# signal. The child becomes `pnpm` directly so the forwarded signal reaches the
# process that owns Nx and its emulator descendants.
(
  exec 9>&-
  exec env -i "${SAFE_ENV[@]}" "${BUILD_ENV[@]}" \
    pnpm exec nx run \
      "${PROJECT}:e2e-implementation:emulator"
) &
CHILD_PID=$!
if wait "$CHILD_PID"; then
  status=0
else
  status=$?
fi
CHILD_PID=""
exit "$status"
