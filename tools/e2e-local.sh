#!/usr/bin/env bash
#
# Runs an e2e project's Playwright suite directly on the host, with the same
# environment CI's "Prepare E2E environment" step sets up.
#
# Why this exists: `nx run <project>:e2e` on a fresh checkout fails twice
# over, and neither failure names its real cause.
#
#   1. `.env.e2e` does not exist (it is gitignored), so the target's own
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
#   tools/e2e-local.sh        # whole suite
#
# Deliberately takes no Playwright passthrough args. The `e2e` target sets
# forwardAllArgs:false, so nx:run-commands silently DROPS trailing args and
# runs the whole suite regardless -- the same trap tools/e2e-docker.sh
# guards against, after a scoped `--grep` that never reached Playwright
# rewrote unrelated specs' screenshot baselines (members#2448). Rather than
# reimplement that guard, this rejects them outright and points at the
# target that does forward them.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${E2E_PROJECT:-@agent-lcars/console-e2e}"
CI_ENV="$ROOT/tools/e2e/ci.env"

# Fail loudly instead of silently running everything - see the usage note.
if [ "$#" -gt 0 ]; then
  echo "tools/e2e-local.sh: refusing to drop arguments: $*" >&2
  echo "  The ':e2e' target sets forwardAllArgs:false, so nx would ignore" >&2
  echo "  them and run the entire suite instead of the subset you asked" >&2
  echo "  for. To scope a run, drive Playwright directly:" >&2
  echo "    pnpm exec nx run ${PROJECT}:e2e-run --grep @smoke" >&2
  exit 2
fi

if [ ! -f "$CI_ENV" ]; then
  echo "tools/e2e-local.sh: missing $CI_ENV" >&2
  exit 1
fi

# Reads one KEY="value" line out of ci.env, stripping its dotenv-style
# quoting. Mirrors tools/e2e-docker.sh's function of the same name.
ci_env_value() {
  local line
  line="$(grep -m1 "^${1}=" "$CI_ENV" || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

# (1) Materialize .env.e2e, never clobbering one you have customized -- same
# rule as the container path.
if [ -f "$ROOT/.env.e2e" ]; then
  echo "tools/e2e-local.sh: using existing .env.e2e"
else
  cp "$CI_ENV" "$ROOT/.env.e2e"
  echo "tools/e2e-local.sh: materialized .env.e2e from tools/e2e/ci.env"
fi

# (2) Export the build-time-critical values so they are set before the
# dependsOn build runs. Sourced from ci.env, not hardcoded.
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
    echo "tools/e2e-local.sh: $key missing from tools/e2e/ci.env" >&2
    exit 1
  fi
  export "$key=$value"
done

# Node's default heap is not enough for the Next production build plus the
# emulators plus Playwright on a loaded workstation; CI sets the same.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

# `--skip-nx-cache` deliberately: an e2e result replayed from the Nx cache
# reports a green suite that never actually ran, which is worse than useless
# when the suite is what you are trying to trust.
exec pnpm exec nx run "${PROJECT}:e2e" --skip-nx-cache
