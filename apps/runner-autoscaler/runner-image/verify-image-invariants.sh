#!/usr/bin/env bash
# Build-time proof of every invariant the runner image itself owns (#2033).
#
# These facts are fixed when the image is built: the Actions Node runtimes,
# the warmed Corepack pnpm, the JRE, the reviewed OpenCode CLI and its --auto
# contract, the baked action-archive cache, the lcars CLI, the layer-1 skills,
# and the absence of any baked Codex credential. Every container starts from
# this exact content-addressed filesystem, and nothing mounts over these
# paths, so proving them once here replaces re-proving them on every boot
# (entrypoint.sh) and every dispatch (direct-runner.sh). An image that fails
# any check never gets published, which is the setup failure #468 wanted to
# surface -- at build rather than after a runner registers.
#
# Runs as the job user so per-user state (Corepack cache, OpenCode scratch,
# ~/.claude, ~/.codex) is checked where jobs actually find it. Reports every
# failure before exiting so one build shows the whole regression.
set -uo pipefail

lib="${AGENT_LCARS_LIB_DIR:-/usr/local/lib/agent-lcars}"
home="${AGENT_LCARS_RUNNER_HOME:-$HOME}"
opencode="${AGENT_LCARS_OPENCODE:-/usr/local/bin/opencode}"
lcars="${AGENT_LCARS_LCARS:-/usr/local/bin/lcars}"
archive_cache="${AGENT_LCARS_ARCHIVE_CACHE:-/opt/actions-archive-cache}"
skills_list="${AGENT_LCARS_LAYER1_SKILLS:-$lib/runtime/layer1-skills.conf}"

# shellcheck source=externals-health.sh
source "$lib/externals-health.sh"
# shellcheck source=toolchain-health.sh
source "$lib/toolchain-health.sh"

failures=0
check() {
  local description="$1"
  shift
  if "$@"; then
    echo "ok: $description"
  else
    echo "FAIL: $description" >&2
    failures=$((failures + 1))
  fi
}

check "Actions node20/node24 runtimes run" required_node_runtimes_run
check "Corepack pnpm runs offline" pnpm_runs
check "Java 21+ runs" java_21_runs
check "trusted OpenCode CLI runs" trusted_opencode_runs "$opencode"
check "trusted OpenCode CLI supports QueueExecutor's --auto mode" \
  trusted_opencode_supports_auto "$opencode"
check "action-archive cache is baked at $archive_cache" test -d "$archive_cache"
check "lcars CLI is executable at $lcars" test -x "$lcars"
check "image carries no Codex authentication" test ! -e "$home/.codex/auth.json"

skills=0
if [ -f "$skills_list" ]; then
  while read -r name; do
    [ -n "$name" ] || continue
    case "$name" in \#*) continue ;; esac
    skills=$((skills + 1))
    check "layer-1 skill '$name' is installed" test -f "$home/.claude/skills/$name/SKILL.md"
  done < "$skills_list"
fi
check "layer-1 skill list names at least one skill" test "$skills" -gt 0

if [ "$failures" -ne 0 ]; then
  echo "verify-image-invariants: $failures image invariant(s) failed" >&2
  exit 1
fi
echo "verify-image-invariants: all image invariants hold"
