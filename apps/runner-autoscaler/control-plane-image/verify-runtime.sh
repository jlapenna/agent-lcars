#!/usr/bin/env bash
set -euo pipefail

required_commands=(git node npm gh jq)
for required in "${required_commands[@]}"; do
  if ! command -v "$required" >/dev/null; then
    echo "control-plane runtime is missing required command: $required" >&2
    exit 1
  fi
done

for forbidden in python python3 python3.12 docker dockerd containerd ctr runc pnpm playwright codex claude opencode; do
  if command -v "$forbidden" >/dev/null; then
    echo "control-plane runtime contains forbidden command: $forbidden" >&2
    exit 1
  fi
done

test -x /home/runner/bin/Runner.Listener
test "$(readlink -f "$(command -v node)")" = /home/runner/externals/node24/bin/node
test "$(readlink -f "$(command -v npm)")" = /home/runner/externals/node24/lib/node_modules/npm/bin/npm-cli.js
test "$(node -p 'process.versions.node')" = 24.22.1
test "${FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:-}" = true
test ! -e /home/runner/externals/node20
npm --version
git --version
gh --version | head -n 1
jq --version

echo 'control-plane runtime contract verified'
