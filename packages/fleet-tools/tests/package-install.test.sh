#!/usr/bin/env bash
# The package's real consumption path: a global install (workstations run
# `pnpm add -g "github:jlapenna/agent-lcars#main&path:packages/fleet-tools"`,
# the runner image installs from its own fresh-main checkout). Assert the
# bin map materializes every fleet-* command and that the node guardrail's
# sibling module travels with the package.
set -euo pipefail
pkg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

npm install -g --prefix "$tmp" "$pkg_dir" >/dev/null 2>&1

for cmd in fleet-claude-agent-session fleet-codex-issue-guardrail \
  fleet-require-worktree fleet-watch-prs fleet-safe-remove-worktree \
  fleet-scan-live-processes; do
  if [ ! -x "$tmp/bin/$cmd" ]; then
    echo "FAIL: $cmd not installed or not executable" >&2
    exit 1
  fi
done

real="$(readlink -f "$tmp/bin/fleet-codex-issue-guardrail")"
if [ ! -f "$(dirname "$real")/fleet-identity.cjs" ]; then
  echo "FAIL: fleet-identity.cjs did not travel with the package" >&2
  exit 1
fi

echo "fleet-tools package install: OK"
