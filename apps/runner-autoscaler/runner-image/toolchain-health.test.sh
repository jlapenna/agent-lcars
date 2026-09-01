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
entrypoint="$here/entrypoint.sh"
opencode_version="$(tr -d '\r\n' < "$here/opencode-version")"
if ! [[ "$opencode_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "opencode-version must contain an exact v-prefixed semantic version" >&2
  exit 1
fi
if ! grep -Fqx 'ARG TARGETARCH' "$dockerfile" ||
  ! grep -Fqx 'COPY opencode-version /usr/local/share/agent-lcars-tooling/opencode-version' "$dockerfile" ||
  ! grep -Fqx 'COPY install-opencode-release.sh /usr/local/lib/agent-lcars/install-opencode-release.sh' "$dockerfile" ||
  ! grep -Fq 'OPENCODE_VERSION="$OPENCODE_VERSION" TARGETARCH="$TARGETARCH"' "$dockerfile" ||
  ! grep -Fq 'bash /usr/local/lib/agent-lcars/install-opencode-release.sh' "$dockerfile" ||
  ! grep -Fq '/usr/local/bin/opencode --version' "$dockerfile"; then
  echo "runner image must install and smoke-check a reviewed root-owned OpenCode CLI" >&2
  exit 1
fi
if grep -Fq 'https://opencode.ai/install' "$dockerfile"; then
  echo "runner image must not run OpenCode's mutable installer as root" >&2
  exit 1
fi
if ! grep -Fqx 'if ! trusted_opencode_runs /usr/local/bin/opencode; then' "$entrypoint" ||
  ! grep -Fqx 'if ! trusted_opencode_supports_auto /usr/local/bin/opencode; then' "$entrypoint"; then
  echo "runner entrypoint must preflight the exact trusted OpenCode executable" >&2
  exit 1
fi
if ! grep -Fqx 'RUN npm install -g /opt/agent-tools' "$dockerfile" ||
  ! grep -Fqx 'ARG REPO_TOOLS_REF=main' "$dockerfile" ||
  ! grep -Fqx 'RUN echo "repo-tools ref: ${REPO_TOOLS_REF}" && \' "$dockerfile" ||
  ! grep -Fqx '    git init /opt/repo-tools && \' "$dockerfile" ||
  ! grep -Fqx '    git -C /opt/repo-tools remote add origin https://github.com/jlapenna/repo-tools.git && \' "$dockerfile" ||
  ! grep -Fqx '    git -C /opt/repo-tools fetch --depth 1 origin "${REPO_TOOLS_REF}" && \' "$dockerfile" ||
  ! grep -Fqx '    git -C /opt/repo-tools checkout --detach FETCH_HEAD && \' "$dockerfile" ||
  ! grep -Fqx '    pnpm --dir /opt/repo-tools install --prod --frozen-lockfile --ignore-scripts && \' "$dockerfile" ||
  ! grep -Fqx '    ln -s /opt/repo-tools/node_modules/.bin/repo-* /usr/local/bin/' "$dockerfile"; then
  echo "runner image must install agent-tools and repo-tools from one source checkout, with a cache-bust guard against a stale registry-cached layer" >&2
  exit 1
fi

if ! grep -Fqx 'COPY repair-node-tar.sh /usr/local/lib/agent-lcars/repair-node-tar.sh' "$dockerfile" ||
  ! grep -Fq 'bash /usr/local/lib/agent-lcars/repair-node-tar.sh' "$dockerfile"; then
  echo "runner image does not repair every inherited npm node-tar copy" >&2
  exit 1
fi

runner_user_line="$(grep -n '^USER runner$' "$dockerfile" | cut -d: -f1)"
codex_install_line="$(grep -n '^RUN npm install -g @openai/codex && codex --version$' "$dockerfile" | cut -d: -f1)"
claude_install_line="$(grep -n '^RUN npm install -g @anthropic-ai/claude-code && claude --version$' "$dockerfile" | cut -d: -f1)"
plugin_line="$(grep -n '^RUN codex plugin marketplace add /opt/repo-tools && \\' "$dockerfile" | cut -d: -f1)"
claude_plugin_line="$(grep -n '^RUN claude plugin marketplace add /opt/repo-tools && \\' "$dockerfile" | cut -d: -f1)"
if [[ -z "$runner_user_line" || -z "$codex_install_line" || "$codex_install_line" -ge "$runner_user_line" || -z "$plugin_line" || "$plugin_line" -le "$runner_user_line" || -z "$claude_plugin_line" || "$claude_plugin_line" -le "$runner_user_line" ]]; then
  echo "runner image must enable the public repo-tools plugins as runner" >&2
  exit 1
fi
if [[ -z "$claude_install_line" || "$claude_install_line" -ge "$runner_user_line" ]]; then
  echo "runner image must install and smoke-check Claude Code before switching users" >&2
  exit 1
fi
if [[ -z "$codex_install_line" || "$codex_install_line" -ge "$runner_user_line" ]]; then
  echo "runner image must install and smoke-check Codex before switching users" >&2
  exit 1
fi
if ! grep -Fqx '    codex plugin add repo-tools@repo-tools' "$dockerfile"; then
  echo "runner image must enable the repo-tools plugin after adding its marketplace" >&2
  exit 1
fi
if ! grep -Fqx '    claude plugin install repo-tools@repo-tools' "$dockerfile"; then
  echo "runner image must install the repo-tools plugin for Claude Code" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/corepack" "$tmp/healthy" "$tmp/broken" "$tmp/missing" \
  "$tmp/java21" "$tmp/java17" "$tmp/java-broken" "$tmp/java-malformed" \
  "$tmp/opencode-healthy" "$tmp/opencode-broken"
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

cat > "$tmp/opencode-healthy/opencode" <<'OPENCODE'
#!/bin/sh
if [ "${1:-}" = run ] && [ "${2:-}" = --help ]; then
  echo '      --auto         auto-approve permissions'
fi
exit 0
OPENCODE
cat > "$tmp/opencode-broken/opencode" <<'OPENCODE'
#!/bin/sh
exit 1
OPENCODE
chmod +x "$tmp"/opencode-*/opencode

trusted_opencode_runs "$tmp/opencode-healthy/opencode" || {
  echo "healthy trusted OpenCode invocation was rejected" >&2
  exit 1
}
trusted_opencode_supports_auto "$tmp/opencode-healthy/opencode" || {
  echo "healthy trusted OpenCode --auto invocation was rejected" >&2
  exit 1
}
if trusted_opencode_runs "$tmp/opencode-broken/opencode"; then
  echo "broken trusted OpenCode invocation was accepted" >&2
  exit 1
fi
if trusted_opencode_supports_auto "$tmp/opencode-broken/opencode"; then
  echo "broken trusted OpenCode --auto invocation was accepted" >&2
  exit 1
fi
if trusted_opencode_runs "$tmp/missing/opencode"; then
  echo "missing trusted OpenCode executable was accepted" >&2
  exit 1
fi
if trusted_opencode_supports_auto "$tmp/missing/opencode"; then
  echo "missing trusted OpenCode --auto invocation was accepted" >&2
  exit 1
fi

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
