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
lib_dir="$(mktemp -d)"
cleanup() {
  if [ -f "$lib_dir/.hook-smoke-drained" ]; then
    rm -rf "$lib_dir"
  else
    echo "hook smoke cleanup: retaining private bundles after refused smoke" >&2
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
cp agents/opencode/lcars-telemetry.js "$opencode_config/"

HOOK_TEST_LIB_DIR="$lib_dir" HOOK_TEST_OPENCODE_CONFIG_DIR="$opencode_config" \
  bash apps/runner-autoscaler/runner-image/hook-telemetry.test.sh
