#!/usr/bin/env bash
# Contract tests for opencode.json.
#
# Every failure mode below is silent in production: OpenCode does not error on
# a missing instructions file or a mis-scoped prompt, it just sends a
# different system message, and the only symptom is an agent that behaves
# worse for reasons nothing logs.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="$repo_root/agents/opencode/opencode.json"
runner_dockerfile="$repo_root/apps/runner-autoscaler/runner-image/Dockerfile"
setup_action="$repo_root/.github/actions/setup-opencode/action.yml"
setup_installer="$repo_root/.github/actions/setup-opencode/install.sh"
agent_lane="$repo_root/.github/workflows/agent-lane.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test -f "$config" || fail "opencode.json is missing"
jq -e . "$config" >/dev/null || fail "opencode.json is not valid JSON"

# --- instructions files must exist -------------------------------------------
# A renamed or moved instructions file does not fail the run. OpenCode drops it
# and the standing orders simply stop reaching the model, which is exactly the
# state agent-lcars#1242 was about.
mapfile -t instruction_paths < <(jq -r '.instructions[]? // empty' "$config")
if [ "${#instruction_paths[@]}" -eq 0 ]; then
  fail "opencode.json declares no instructions; the standing orders reach the model through that field (#1242)"
fi
config_dir="$(dirname "$config")"
for path in "${instruction_paths[@]}"; do
  case "$path" in
    http://* | https://*) continue ;;
  esac
  test -f "$config_dir/$path" ||
    fail "instructions entry '$path' does not exist; OpenCode drops missing files silently"
done

# --- the standing orders must still say the thing they exist to say ----------
orders="$repo_root/agents/opencode/instructions.md"
test -f "$orders" || fail "agents/opencode/instructions.md is missing"
grep -Fq "Commit and push at the first working slice" "$orders" ||
  fail "the standing orders no longer carry the commit-early rule they exist for"

# --- agent.*.prompt must stay unset ------------------------------------------
# Measured 2026-08-16 against opencode 1.18.18 by capturing the wire request:
# setting `agent.build.prompt` REPLACES OpenCode's stock system prompt rather
# than appending to it. The system message went 19,602 -> 10,929 characters and
# lost "You are opencode, an interactive CLI tool..." along with all of its
# tool guidance. `instructions` is the additive field; it lands in the same
# system message without destroying anything.
if jq -e '.agent // {} | to_entries | map(select(.value.prompt)) | length > 0' "$config" >/dev/null; then
  fail "agent.*.prompt REPLACES OpenCode's stock system prompt (measured, opencode 1.18.18) - use .instructions to add text"
fi

# --- the context/output budget must stay inside its documented bounds --------
# docs/opencode-context-limit.md derives both. The floor is a dispatch's ~21k
# fixed cost; the ceiling is the 64k point where ds4-serve drops to
# non-speculative decode.
while read -r model context output; do
  [ "$context" -gt 24000 ] ||
    fail "$model context $context is at or below the fixed cost of a dispatch; the agent will compact before it can work"
  [ "$context" -lt 64000 ] ||
    fail "$model context $context crosses the 64k ds4-serve deep-prompt threshold (docs/opencode-context-limit.md)"
  [ "$output" -ge 4096 ] ||
    fail "$model output $output cannot emit a whole component file in one turn"
done < <(jq -r '.provider.homelab.models | to_entries[] | "\(.key) \(.value.limit.context) \(.value.limit.output)"' "$config")

# --- the runner owns the shared configuration --------------------------------
# The provider config and standing instructions apply to every agent job, so
# they belong in the one managed runner image, not in each consumer checkout.
# A source-level contract catches either half of a relative instructions path
# being moved without the other, and prevents a later workspace download from
# recreating the retired copy-on-every-run design.
grep -Fq '/repo/agents/opencode/opencode.json' "$runner_dockerfile" ||
  fail "runner image no longer installs the shared opencode.json"
grep -Fq '/home/runner/.config/opencode/opencode.json' "$runner_dockerfile" ||
  fail "runner image does not install opencode.json at the runner global config path"
grep -Fq '/repo/agents/opencode/instructions.md' "$runner_dockerfile" ||
  fail "runner image no longer installs the OpenCode standing instructions"
grep -Fq '/home/runner/.config/opencode/instructions.md' "$runner_dockerfile" ||
  fail "runner image does not preserve opencode.json's relative instructions path"
if grep -Fq 'Install OpenCode config' "$setup_action" ||
  grep -Fq 'agents/opencode/opencode.json' "$setup_action"; then
  fail "setup-opencode must install the CLI only; runner configuration is managed by the image"
fi
test -x "$setup_installer" ||
  fail "setup-opencode must retain its shared executable installer"
bash -n "$setup_installer" ||
  fail "setup-opencode shared installer must be valid bash"
if OPENCODE_VERSION=latest "$setup_installer" >/dev/null 2>&1; then
  fail "setup-opencode shared installer accepted a floating release"
fi
grep -Fq "run: '\$GITHUB_ACTION_PATH/install.sh'" "$setup_action" ||
  fail "setup-opencode must invoke the shared OpenCode installer"
grep -Fq '/usr/local/lib/agent-lcars/install-opencode-release.sh' "$runner_dockerfile" ||
  fail "runner image must use its reviewed OpenCode release installer"
if grep -Fq '/repo/.github/actions/setup-opencode/install.sh' "$runner_dockerfile" ||
  grep -Fq 'https://opencode.ai/install' "$runner_dockerfile"; then
  fail "runner image must not use setup-opencode's mutable installer as root"
fi
grep -Fq 'run: /usr/local/bin/opencode github run' "$agent_lane" ||
  fail "dispatch-bootstrap OpenCode must invoke the trusted image executable"
if grep -Fq 'uses: anomalyco/opencode/github@' "$agent_lane"; then
  fail "dispatch-bootstrap must not install an action-owned OpenCode CLI that telemetry rejects"
fi

echo "opencode-config: ok"
