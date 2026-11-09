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
agy="${AGENT_LCARS_AGY:-/usr/local/bin/agy}"
lcars="${AGENT_LCARS_LCARS:-/usr/local/bin/lcars}"
hindsight_cli="${AGENT_LCARS_HINDSIGHT_CLI:-/usr/bin/hindsight-coding-agents}"
archive_cache="${AGENT_LCARS_ARCHIVE_CACHE:-/opt/actions-archive-cache}"
skills_list="${AGENT_LCARS_LAYER1_SKILLS:-$lib/runtime/layer1-skills.conf}"
repo_tools="${AGENT_LCARS_REPO_TOOLS:-/opt/repo-tools}"
repo_tools_bin="${AGENT_LCARS_REPO_TOOLS_BIN:-/usr/local/bin}"

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

check "Actions Node 24 migration and runtime run" required_node_runtimes_run
check "Corepack pnpm runs offline" pnpm_runs
check "every fleet-pinned pnpm and the default resolve offline" pinned_pnpm_runs_offline
check "pinned repository scanners run as runner" repo_checks_run
check "Java 21+ runs" java_21_runs
check "Terraform CLI runs as runner" terraform version -json
check "managed Python 3.14 runs as runner" bash -c '"$(uv python find --managed-python 3.14)" --version'
check "trusted OpenCode CLI runs" trusted_opencode_runs "$opencode"
check "trusted OpenCode CLI supports QueueExecutor's --auto mode" \
  trusted_opencode_supports_auto "$opencode"
check "trusted Antigravity CLI runs" trusted_agy_runs "$agy"
check "empty version-matched OpenCode store is baked" bash "$lib/check-opencode-store.sh"
check "action-archive cache is baked at $archive_cache" test -d "$archive_cache"
check "lcars CLI is executable at $lcars" test -x "$lcars"
check "repo-tools commands are installed and the worktree guard executes" \
  node "$lib/repo-tools-bins.mjs" verify "$repo_tools" "$repo_tools_bin"
check "image carries no Codex authentication" test ! -e "$home/.codex/auth.json"
check "image carries no Antigravity authentication" test ! -e "$home/.gemini/antigravity-cli/antigravity-oauth-token"
check "Hindsight coding-agents CLI is installed" test -x "$hindsight_cli"
check "Hindsight runtime is staged for runner" test -f "$home/.hindsight/coding-agents/dist/index.js"
check "Hindsight OpenCode wrapper is installed" test -f "$home/.config/opencode/hindsight.js"
check "Hindsight skill is installed for Claude, Codex and Antigravity" bash -c \
  'test -f "$1/.claude/skills/hindsight-coding-agent/SKILL.md" && test -f "$1/.agents/skills/hindsight-coding-agent/SKILL.md" && test -f "$1/.gemini/antigravity-cli/skills/hindsight-coding-agent/SKILL.md"' _ "$home"
check "image carries disabled Hindsight config with no baked token" \
  jq -e '.disabled == true and (.apiToken // null) == null' "$home/.hindsight/coding-agent.json" >/dev/null

skills=0
if [ -f "$skills_list" ]; then
  while read -r name; do
    [ -n "$name" ] || continue
    case "$name" in \#*) continue ;; esac
    skills=$((skills + 1))
    check "layer-1 skill '$name' is installed" test -f "$home/.claude/skills/$name/SKILL.md"
    check "layer-1 skill '$name' is installed for Antigravity" test -f "$home/.gemini/antigravity-cli/skills/$name/SKILL.md"
  done < "$skills_list"
fi
check "layer-1 skill list names at least one skill" test "$skills" -gt 0

if [ "$failures" -ne 0 ]; then
  echo "verify-image-invariants: $failures image invariant(s) failed" >&2
  exit 1
fi
echo "verify-image-invariants: all image invariants hold"
