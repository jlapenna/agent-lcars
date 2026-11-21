#!/usr/bin/env bash
# Run the runner image's hook telemetry contract
# (apps/runner-autoscaler/runner-image/hook-telemetry.test.sh) against this
# checkout's bundles, using the Claude Code, Codex and OpenCode CLIs already
# on this runner. The image runs the same test against main when it is
# published; this run catches a regression in the hook client before merge.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

./tools/nx session-title-cli @agent-lcars/telemetry-watcher
./tools/nx hook-cli @agent-lcars/telemetry-watcher
./tools/nx hook-flush-cli @agent-lcars/telemetry-watcher

# `lcars hook` starts the flusher from beside its own bundle, as in the image.
# Keep the 30 s process-drain bound: airgapped image builds (`RUN --network=none`)
# still hard-fail if a fixture leaks a client, while this runtime CI smoke sets
# HOOK_SMOKE_DEGRADE_DEADLINE=1 so a slow background child past 30 s logs culprit
# command names, retains private scratch/bundles for inspection, and emits a
# GitHub Actions warning rather than blocking Verify and Console deploys (#3421).
lib_dir="$(mktemp -d)"
cleanup() {
  local exit_status=$?
  if [ -f "$lib_dir/.hook-smoke-drained" ]; then
    rm -rf "$lib_dir"
  else
    echo "hook smoke cleanup: retaining private bundles after refused smoke" >&2
    if [ "$exit_status" -eq 0 ] && [ -f "$lib_dir/.hook-smoke-deadline-degraded" ]; then
      echo "::warning::hook smoke cleanup retained private scratch after process drain deadline (see stderr for culprit process names)"
    fi
  fi
}
trap cleanup EXIT
cp dist/apps/telemetry-watcher-session-title-cli/lcars-session-title.cjs \
  dist/apps/telemetry-watcher-hook/lcars-hook.cjs \
  dist/apps/telemetry-watcher-hook-flush/lcars-hook-flush.cjs "$lib_dir/"

# This checkout's OpenCode plugin beside the runner's baked plugin SDK.
opencode_config="$lib_dir/opencode"
mkdir -p "$opencode_config"
cp -R "$HOME/.config/opencode/package.json" "$HOME/.config/opencode/package-lock.json" \
  "$HOME/.config/opencode/node_modules" "$opencode_config/"
cp agents/opencode/opencode.json agents/opencode/instructions.md \
  agents/opencode/context-lifecycle.js agents/opencode/lcars-session.js \
  agents/opencode/lcars-telemetry.js agents/opencode/hindsight.js "$opencode_config/"

# CI exercises the installed CLI/SDK pair with this checkout's plugins and
# assertions. A future image-pin update must not require its new image before
# source CI can pass. Image publication still checks the source tooling pin.
cp apps/runner-autoscaler/runner-image/{hook-telemetry.test.sh,hook-telemetry-assertions.sh,opencode-continuation.test.sh,opencode-continuation.test.py,drain-hook-test-clients.py} "$lib_dir/"
node -p 'require(process.argv[1]).version' \
  "$opencode_config/node_modules/@opencode-ai/plugin/package.json" > "$lib_dir/opencode-version"

HOOK_TEST_LIB_DIR="$lib_dir" \
HOOK_TEST_OPENCODE_CONFIG_DIR="$opencode_config" \
HOOK_SMOKE_DEGRADE_DEADLINE="${HOOK_SMOKE_DEGRADE_DEADLINE:-1}" \
  bash "$lib_dir/hook-telemetry.test.sh"
