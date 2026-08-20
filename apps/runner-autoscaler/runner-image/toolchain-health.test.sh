#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=toolchain-health.sh
source "$here/toolchain-health.sh"

# The Go image tag is intentionally duplicated only because Docker must know
# it before any build stage exists. Keep that release identical to the Go
# module Verify compiles, otherwise the baked image would hide a toolchain
# mismatch until a real CI job ran.
go_mod_version="$(sed -nE 's/^go ([0-9]+\.[0-9]+\.[0-9]+)$/\1/p' "$here/../go.mod")"
docker_go_version="$(sed -nE 's/^ARG GO_VERSION=([0-9]+\.[0-9]+\.[0-9]+)$/\1/p' "$here/Dockerfile")"
if [[ -z "$go_mod_version" || "$go_mod_version" != "$docker_go_version" ]]; then
  echo "runner image Go version must match apps/runner-autoscaler/go.mod" >&2
  exit 1
fi

actionlint_version="$(tr -d '\r\n' < "$here/actionlint-version")"
if ! [[ "$actionlint_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "actionlint-version must contain an exact semantic version" >&2
  exit 1
fi

dockerfile="$here/Dockerfile"
if ! grep -Fqx 'RUN npm install -g /opt/agent-tools' "$dockerfile" ||
  ! grep -Fqx '    pnpm --dir /opt/repo-tools add --ignore-scripts github:jlapenna/repo-tools#main && \' "$dockerfile" ||
  ! grep -Fqx '    ln -s /opt/repo-tools/node_modules/.bin/repo-* /usr/local/bin/' "$dockerfile"; then
  echo "runner image must install agent-tools and public repo-tools separately" >&2
  exit 1
fi

runner_user_line="$(grep -n '^USER runner$' "$dockerfile" | cut -d: -f1)"
codex_install_line="$(grep -n '^RUN npm install -g @openai/codex$' "$dockerfile" | cut -d: -f1)"
plugin_line="$(grep -n '^RUN codex plugin marketplace add jlapenna/repo-tools --ref main && \\' "$dockerfile" | cut -d: -f1)"
if [[ -z "$runner_user_line" || -z "$codex_install_line" || "$codex_install_line" -ge "$runner_user_line" || -z "$plugin_line" || "$plugin_line" -le "$runner_user_line" ]]; then
  echo "runner image must enable the public repo-tools plugin as runner" >&2
  exit 1
fi
if ! grep -Fqx '    codex plugin add repo-tools@repo-tools' "$dockerfile"; then
  echo "runner image must enable the repo-tools plugin after adding its marketplace" >&2
  exit 1
fi

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
