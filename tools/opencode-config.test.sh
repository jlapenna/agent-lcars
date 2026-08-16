#!/usr/bin/env bash
# Contract tests for opencode.json.
#
# Every failure mode below is silent in production: OpenCode does not error on
# a missing instructions file or a mis-scoped prompt, it just sends a
# different system message, and the only symptom is an agent that behaves
# worse for reasons nothing logs.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="$repo_root/opencode.json"

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
for path in "${instruction_paths[@]}"; do
  case "$path" in
    http://* | https://*) continue ;;
  esac
  test -f "$repo_root/${path#./}" ||
    fail "instructions entry '$path' does not exist; OpenCode drops missing files silently"
done

# --- the standing orders must still say the thing they exist to say ----------
orders="$repo_root/.agents/opencode-standing-orders.md"
test -f "$orders" || fail ".agents/opencode-standing-orders.md is missing"
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

echo "opencode-config: ok"
