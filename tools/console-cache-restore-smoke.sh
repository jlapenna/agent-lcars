#!/bin/bash
# Prove the production console task can restore a complete deployable output
# from a job-local Nx cache, without relying on the private Spark L2. This is
# an artifact-integrity check; it does not claim that App Hosting persists the
# cache between archive builds.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -n "${NX_SKIP_NX_CACHE:-}" ]; then
  echo 'NX_SKIP_NX_CACHE must be unset for the console cache smoke.' >&2
  exit 1
fi

export CI=true
export CLOUD_BUILD=true
export NX_DAEMON=false
export NX_TUI=false

smoke_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$smoke_dir"
}
trap cleanup EXIT

build_bundle() {
  . tools/cloud-build-prebuild.sh
  ./tools/nx run @agent-lcars/console:bundle --skipRemoteCache --verbose
}

echo 'Populating the job-local Nx cache from a production console bundle...'
build_bundle

echo 'Removing outputs and restoring the deployable bundle from local Nx cache...'
build_bundle 2>&1 | tee "$smoke_dir/cache-restore.log"

# Nx uses this exact marker when it copies missing outputs from L1. Merely
# seeing "existing outputs match" would not prove the standalone tree was
# restored after cloud-build-prebuild removed dist.
sed -E $'s/\x1B\\[[0-9;]*[mK]//g' "$smoke_dir/cache-restore.log" \
  >"$smoke_dir/cache-restore.plain.log"
if ! grep -Eq '@agent-lcars/console:build.*\[local cache\]' \
  "$smoke_dir/cache-restore.plain.log"; then
  echo 'Console build was not restored from the job-local Nx cache.' >&2
  exit 1
fi

./tools/console-standalone-smoke.sh
