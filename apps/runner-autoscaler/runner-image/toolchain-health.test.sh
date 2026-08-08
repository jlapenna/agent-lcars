#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=toolchain-health.sh
source "$here/toolchain-health.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/corepack" "$tmp/healthy" "$tmp/broken" "$tmp/missing"
cat > "$tmp/healthy/pnpm" <<'PNPM'
#!/bin/sh
exit 0
PNPM
cat > "$tmp/broken/pnpm" <<'PNPM'
#!/bin/sh
exit 1
PNPM
chmod +x "$tmp/healthy/pnpm" "$tmp/broken/pnpm"

caller_pwd="$PWD"
AGENT_LCARS_COREPACK_DIR="$tmp/corepack" PATH="$tmp/healthy" pnpm_runs || {
  echo "healthy pnpm invocation was rejected" >&2
  exit 1
}
if [[ "$PWD" != "$caller_pwd" ]]; then
  echo "pnpm preflight changed the caller's working directory" >&2
  exit 1
fi
if AGENT_LCARS_COREPACK_DIR="$tmp/corepack" PATH="$tmp/broken" pnpm_runs; then
  echo "broken pnpm invocation was accepted" >&2
  exit 1
fi
if AGENT_LCARS_COREPACK_DIR="$tmp/corepack" PATH="$tmp/missing" pnpm_runs; then
  echo "missing pnpm executable was accepted" >&2
  exit 1
fi
if AGENT_LCARS_COREPACK_DIR="$tmp/absent-corepack-dir" PATH="$tmp/healthy" pnpm_runs; then
  echo "missing Corepack manifest directory was accepted" >&2
  exit 1
fi

echo "toolchain-health.test.sh: all cases passed"
