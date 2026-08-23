#!/usr/bin/env bash
# Verify the telemetry-watcher sidecar artifact runs without an ambient
# node_modules tree. The runner image and the standalone daemon both execute
# this bundle, so a successful image build alone is not sufficient evidence.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

./tools/nx bundle @agent-lcars/telemetry-watcher

smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
cp dist/apps/telemetry-watcher/sidecar.cjs "$smoke_dir/"
mkdir -p "$smoke_dir/projects" "$smoke_dir/codex" "$smoke_dir/checkout"

# No credentials are configured, so the sidecar deliberately uses its
# log-only store. It is a daemon; the startup log, not timeout's exit code,
# establishes that the isolated artifact loaded and began watching.
(
  cd "$smoke_dir"
  AGENT_TELEMETRY_WATCH_ROOTS="[{\"path\":\"$smoke_dir/projects\",\"adapter\":\"claude-code\",\"projectDirAllowlist\":[\"*\"]},{\"path\":\"$smoke_dir/codex\",\"adapter\":\"codex\",\"recursive\":true,\"cwdAllowlist\":[\"$smoke_dir/checkout*\"]}]" \
    AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB='' \
    timeout 30s node sidecar.cjs
) >"$smoke_dir/out.log" 2>&1 || true

if ! grep -q 'starting; watching' "$smoke_dir/out.log"; then
  echo 'telemetry-watcher bundle did not start standalone' >&2
  cat "$smoke_dir/out.log" >&2
  exit 1
fi

grep 'starting; watching' "$smoke_dir/out.log"
