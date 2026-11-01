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
# Ordering guards for the shipped (final) stage. Earlier build stages have
# their own `USER runner` (#3004), so every line number is taken from the
# final stage only, and a missing or ambiguous line fails the guard instead
# of erroring inside `[[ ]]`, which an `if` would read as a pass.
check_final_stage_order() {
  local df=$1 final_from
  final_from="$(grep -n '^FROM ' "$df" | tail -n1 | cut -d: -f1)"
  # First (or, with "last", final) exact match after the last FROM.
  final_line() {
    grep -nFx -- "$1" "$df" | cut -d: -f1 |
      awk -v from="$final_from" -v pick="${2:-first}" \
        '$1 > from { line = $1; if (pick == "first") { print line; exit } }
         END { if (pick == "last" && line) print line }'
  }
  local user codex claude plugin claude_plugin pnpm_warm skills invariants
  user="$(final_line 'USER runner')"
  codex="$(final_line 'RUN npm install -g @openai/codex && codex --version')"
  claude="$(final_line 'RUN npm install -g @anthropic-ai/claude-code && claude --version')"
  plugin="$(final_line 'RUN codex plugin marketplace add /opt/repo-tools && \')"
  claude_plugin="$(final_line 'RUN claude plugin marketplace add /opt/repo-tools && \')"
  pnpm_warm="$(final_line 'RUN pnpm --version' last)"
  skills="$(grep -n '^RUN bash /usr/local/lib/agent-lcars/runtime/install-skills.sh ' "$df" | cut -d: -f1 |
    awk -v from="$final_from" '$1 > from { print; exit }')"
  invariants="$(final_line 'RUN bash /usr/local/lib/agent-lcars/verify-image-invariants.sh')"
  before() { [[ "$1" =~ ^[0-9]+$ && "$2" =~ ^[0-9]+$ ]] && (($1 < $2)); }
  if ! before "$codex" "$user"; then
    echo "runner image must install and smoke-check Codex before switching users" >&2
    return 1
  fi
  if ! before "$claude" "$user"; then
    echo "runner image must install and smoke-check Claude Code before switching users" >&2
    return 1
  fi
  if ! before "$user" "$plugin" || ! before "$user" "$claude_plugin"; then
    echo "runner image must enable the public repo-tools plugins as runner" >&2
    return 1
  fi
  # #2033: the image build, not every boot, proves the toolchain. The gate
  # must run as the job user after the last per-user warm-up.
  if ! before "$user" "$skills" || ! before "$skills" "$invariants" || ! before "$pnpm_warm" "$invariants"; then
    echo "runner image must install layer-1 skills and then run verify-image-invariants.sh as runner after the pnpm warm-up" >&2
    return 1
  fi
}
check_final_stage_order "$dockerfile" || exit 1
# Boot must not quietly grow the retired per-container probes back (#2033).
if grep -Eq 'trusted_opencode|pnpm_runs|java_21_runs|required_node_runtimes_run' "$entrypoint"; then
  echo "runner entrypoint must not re-run build-proven toolchain probes on every boot (#2033)" >&2
  exit 1
fi
# The repo-tools install is pinned to its exact `(cd ... && pnpm install)`
# form, not just to "some pnpm install". `pnpm --dir` runs from THIS repo's
# directory, so corepack resolves the pnpm version from Agent LCARS's
# package.json and then refuses repo-tools' own `packageManager` declaration
# the moment the two pins drift - which is what broke every runner-image
# publish when #1838 bumped ours (fixed in #1844). Reverting to `--dir` must
# fail here rather than at image-build time.
if ! grep -Fqx 'RUN npm install -g /opt/agent-tools' "$dockerfile" ||
  ! grep -Fqx 'ARG REPO_TOOLS_REF=main' "$dockerfile" ||
  ! grep -Fqx '    git init /opt/repo-tools && \' "$dockerfile" ||
  ! grep -Fqx '    git -C /opt/repo-tools remote add origin https://github.com/jlapenna/repo-tools.git && \' "$dockerfile" ||
  ! grep -Fqx '    git -C /opt/repo-tools fetch --depth 1 origin "${REPO_TOOLS_REF}" && \' "$dockerfile" ||
  ! grep -Fqx '    git -C /opt/repo-tools checkout --detach FETCH_HEAD && \' "$dockerfile" ||
  ! grep -Fqx '    (cd /opt/repo-tools && pnpm install --prod --frozen-lockfile --ignore-scripts) && \' "$dockerfile" ||
  ! grep -Fqx 'COPY repo-tools-bins.mjs /usr/local/lib/agent-lcars/repo-tools-bins.mjs' "$dockerfile" ||
  ! grep -Fqx '    node /usr/local/lib/agent-lcars/repo-tools-bins.mjs install /opt/repo-tools /usr/local/bin' "$dockerfile"; then
  echo "runner image must install agent-tools and repo-tools from one source checkout, with a cache-bust guard against a stale registry-cached layer" >&2
  exit 1
fi

# This is packaging/wiring evidence only. repo-tools-bins.test.mjs covers
# installation failures, and the final image gate executes the actual guard
# as runner. Do not pin a logging line or the retired dependency-shim glob:
# that literal assertion accepted a dangling link in the first #2029 canary.

if ! grep -Fqx 'COPY repair-node-tar.sh /usr/local/lib/agent-lcars/repair-node-tar.sh' "$dockerfile" ||
  ! grep -Fq 'bash /usr/local/lib/agent-lcars/repair-node-tar.sh' "$dockerfile"; then
  echo "runner image does not repair every inherited npm node-tar copy" >&2
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

# Fake Corepack shim: answers only with the registry disabled, only for a
# version present in FAKE_CACHED, and resolves FAKE_DEFAULT outside a project.
mkdir -p "$tmp/pinned" "$tmp/fleet-corepack"
cat > "$tmp/pinned/pnpm" <<'PNPM'
#!/bin/sh
[ "$COREPACK_ENABLE_NETWORK" = 0 ] || exit 2
if [ -f package.json ]; then
  version="$(sed -nE 's/.*"pnpm@([0-9.]+)[^"]*".*/\1/p' package.json)"
else
  version="$FAKE_DEFAULT"
fi
case " $FAKE_CACHED " in *" $version "*) echo "$version" ;; *) exit 1 ;; esac
PNPM
chmod +x "$tmp/pinned/pnpm"
printf '{"packageManager": "pnpm@11.28.5+sha512.abc"}\n' > "$tmp/fleet-corepack/package.json"
printf '%s\n' 'pnpm@11.28.2' 'pnpm@11.28.5+sha512.abc' > "$tmp/fleet-corepack/fleet-pnpm-pins"
pinned() {
  AGENT_LCARS_COREPACK_DIR="$tmp/fleet-corepack" PATH="$tmp/pinned:$(dirname "$(command -v node)"):/usr/bin:/bin" \
    FAKE_CACHED="$1" FAKE_DEFAULT="$2" pinned_pnpm_runs_offline
}
pinned "11.28.2 11.28.5" 11.28.5 || {
  echo "every fleet pin cached offline was rejected" >&2
  exit 1
}
if pinned "11.28.5" 11.28.5; then
  echo "a fleet pin missing from the Corepack cache was accepted" >&2
  exit 1
fi
if pinned "11.28.2 11.28.5 12.9.1" 12.9.1; then
  echo "an out-of-project default other than this repo's pin was accepted" >&2
  exit 1
fi
: > "$tmp/fleet-corepack/fleet-pnpm-pins"
if pinned "11.28.2 11.28.5" 11.28.5; then
  echo "an empty fleet pin list was accepted" >&2
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

# Exercise the image's runtime predicate through PATH, including every
# scanner being missing or reporting a different version.
mkdir "$tmp/scanners"
for utility in head sed awk cat; do
  ln -s "$(command -v "$utility")" "$tmp/scanners/$utility"
done
scanner() {
  printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "$2" > "$tmp/scanners/$1"
  chmod +x "$tmp/scanners/$1"
}
scanner gitleaks 8.30.1
scanner actionlint "v$actionlint_version"
scanner shellcheck 'version: 0.10.0'
scanner pyflakes '3.2.0 Python 3.12 on Linux'
scanners_run() {
  AGENT_LCARS_REPO_CHECKS_PINS="$here/repo-checks.env" \
    AGENT_LCARS_ACTIONLINT_PIN="${1:-$here/actionlint-version}" PATH="$tmp/scanners" repo_checks_run
}
scanners_run || { echo 'matching scanner versions rejected' >&2; exit 1; }
for binary in gitleaks actionlint shellcheck pyflakes; do
  cp "$tmp/scanners/$binary" "$tmp/saved-scanner"
  printf '\nexit 1\n' >> "$tmp/scanners/$binary"
  if scanners_run; then
    echo "failing $binary with expected version output accepted" >&2; exit 1
  fi
  scanner "$binary" wrong
  if scanners_run; then
    echo "wrong $binary version accepted" >&2; exit 1
  fi
  rm "$tmp/scanners/$binary"
  if scanners_run; then
    echo "missing $binary accepted" >&2; exit 1
  fi
  mv "$tmp/saved-scanner" "$tmp/scanners/$binary"
done

# An absent or empty expected version must never match empty successful output.
scanner actionlint ''
if scanners_run "$tmp/absent-actionlint-pin"; then
  echo 'missing actionlint pin matched empty version output' >&2; exit 1
fi
: > "$tmp/empty-actionlint-pin"
if scanners_run "$tmp/empty-actionlint-pin"; then
  echo 'empty actionlint pin matched empty version output' >&2; exit 1
fi
scanner actionlint "v$actionlint_version"
scanners_run || { echo 'restored actionlint pin rejected' >&2; exit 1; }

# Each ordering guard must trip on its own violation. move_line moves the
# last exact occurrence of a line to just before or after the first exact
# anchor in the final stage; an absent anchor only deletes the line.
move_line() {
  MOVE_SRC=$2 MOVE_ANCHOR=$3 MOVE_WHERE=$4 awk '
    NR == FNR { if ($0 == ENVIRON["MOVE_SRC"]) src = NR; if (/^FROM /) from = NR; next }
    FNR == src { next }
    FNR > from && !done && $0 == ENVIRON["MOVE_ANCHOR"] {
      if (ENVIRON["MOVE_WHERE"] == "before") print ENVIRON["MOVE_SRC"]
      print
      if (ENVIRON["MOVE_WHERE"] == "after") print ENVIRON["MOVE_SRC"]
      done = 1
      next
    }
    { print }' "$dockerfile" "$dockerfile" >"$1"
}
expect_order_failure() {
  local name=$1 message=$2 err
  shift 2
  move_line "$tmp/$name.Dockerfile" "$@"
  if err="$(check_final_stage_order "$tmp/$name.Dockerfile" 2>&1)"; then
    echo "ordering guard accepted $name" >&2
    exit 1
  fi
  [[ "$err" == "$message" ]] || { echo "ordering guard for $name reported: $err" >&2; exit 1; }
}
codex_msg="runner image must install and smoke-check Codex before switching users"
expect_order_failure no-final-user "$codex_msg" 'USER runner' '<absent>' after
expect_order_failure user-before-codex "$codex_msg" \
  'USER runner' 'RUN npm install -g @openai/codex && codex --version' before
expect_order_failure user-before-claude \
  "runner image must install and smoke-check Claude Code before switching users" \
  'USER runner' 'RUN npm install -g @anthropic-ai/claude-code && claude --version' before
expect_order_failure plugins-before-user "runner image must enable the public repo-tools plugins as runner" \
  'USER runner' '    claude plugin install repo-tools@repo-tools' after
expect_order_failure claude-plugin-before-user "runner image must enable the public repo-tools plugins as runner" \
  'RUN claude plugin marketplace add /opt/repo-tools && \' 'USER runner' before
skills_msg="runner image must install layer-1 skills and then run verify-image-invariants.sh as runner after the pnpm warm-up"
expect_order_failure skills-before-user "$skills_msg" \
  'RUN bash /usr/local/lib/agent-lcars/runtime/install-skills.sh \' 'USER runner' before
expect_order_failure invariants-before-skills "$skills_msg" \
  'RUN bash /usr/local/lib/agent-lcars/verify-image-invariants.sh' \
  'RUN bash /usr/local/lib/agent-lcars/runtime/install-skills.sh \' before
expect_order_failure invariants-before-pnpm-warm "$skills_msg" \
  'RUN pnpm --version' 'RUN bash /usr/local/lib/agent-lcars/verify-image-invariants.sh' after

echo "toolchain-health.test.sh: all cases passed"
