#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=toolchain-health.sh
source "$here/toolchain-health.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/corepack" "$tmp/healthy" "$tmp/broken" "$tmp/missing" \
  "$tmp/java21" "$tmp/java17" "$tmp/java-broken" "$tmp/java-malformed"
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

cat > "$tmp/java21/java" <<'JAVA'
#!/bin/sh
printf '%s\n' 'openjdk version "21.0.8" 2025-07-15' >&2
JAVA
cat > "$tmp/java17/java" <<'JAVA'
#!/bin/sh
printf '%s\n' 'openjdk version "17.0.16" 2025-07-15' >&2
JAVA
cat > "$tmp/java-broken/java" <<'JAVA'
#!/bin/sh
exit 1
JAVA
cat > "$tmp/java-malformed/java" <<'JAVA'
#!/bin/sh
printf '%s\n' 'a Java runtime that does not identify its version' >&2
JAVA
chmod +x "$tmp"/java*/java

AGENT_LCARS_JAVA_COMMAND="$tmp/java21/java" java_21_runs || {
  echo "Java 21 runtime was rejected" >&2
  exit 1
}
if AGENT_LCARS_JAVA_COMMAND="$tmp/java17/java" java_21_runs; then
  echo "Java 17 runtime was accepted" >&2
  exit 1
fi
if AGENT_LCARS_JAVA_COMMAND="$tmp/java-broken/java" java_21_runs; then
  echo "broken Java runtime was accepted" >&2
  exit 1
fi
if AGENT_LCARS_JAVA_COMMAND="$tmp/java-malformed/java" java_21_runs; then
  echo "malformed Java runtime was accepted" >&2
  exit 1
fi
if AGENT_LCARS_JAVA_COMMAND="$tmp/missing/java" java_21_runs; then
  echo "missing Java runtime was accepted" >&2
  exit 1
fi

echo "toolchain-health.test.sh: all cases passed"
