#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI_ENV="$ROOT/tools/e2e/ci.env"
VALIDATOR="$ROOT/tools/e2e/validate-env.mjs"
CALLER_HOME="${HOME:-}"
PLATFORM="$(uname -s)"

if [ "$#" -eq 0 ]; then
  echo "usage: tools/e2e/run-hermetic.sh <command> [args...]" >&2
  exit 2
fi

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
trap 'rm -rf "$TEMP_HOME"' EXIT
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

env -i "${SAFE_ENV[@]}" "${BUILD_ENV[@]}" "$@"
