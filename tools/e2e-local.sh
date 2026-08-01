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
#   tools/e2e-local.sh                        # emulator, whole suite
#   E2E_GREP='@smoke' tools/e2e-local.sh      # emulator, scoped suite
#   E2E_CONFIGURATION=live tools/e2e-local.sh # live, whole suite
#
# Deliberately takes no Playwright passthrough args. The `e2e` target sets
# forwardAllArgs:false, so nx:run-commands silently DROPS trailing args and
# runs the whole suite regardless -- the same trap tools/e2e-docker.sh
# guards against, after a scoped `--grep` that never reached Playwright
# rewrote unrelated specs' screenshot baselines (members#2448). Rather than
# reimplement that guard, this rejects them outright and points back at this
# same hermetic entrypoint with E2E_GREP.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${E2E_PROJECT:-@agent-lcars/console-e2e}"
CONFIGURATION="${E2E_CONFIGURATION:-emulator}"
HERMETIC_RUNNER="$ROOT/tools/e2e/run-hermetic.sh"

case "$CONFIGURATION" in
  emulator | live) ;;
  *)
    echo "tools/e2e-local.sh: unsupported E2E_CONFIGURATION: $CONFIGURATION" >&2
    exit 2
    ;;
esac

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

# `--skip-nx-cache` deliberately: an e2e result replayed from the Nx cache
# reports a green suite that never actually ran, which is worse than useless
# when the suite is what you are trying to trust.
exec "$HERMETIC_RUNNER" \
  pnpm exec nx run \
    "${PROJECT}:e2e-implementation:${CONFIGURATION}" --skip-nx-cache
