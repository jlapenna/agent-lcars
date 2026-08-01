#!/usr/bin/env bash

set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

consumer="$test_root/consumer"
runner_temp="$test_root/runner-temp"
mkdir -p "$consumer" "$runner_temp"

export GITHUB_ACTION_PATH="$action_dir"
export GITHUB_ENV="$test_root/github-env"
export GITHUB_OUTPUT="$test_root/github-output"
export GITHUB_REPOSITORY="example/consumer"
export RUNNER_TEMP="$runner_temp"
export AGENT="Test Agent"
export ISSUE="123"
export MODE="reply"
# These characters must remain inert task data.
# shellcheck disable=SC2016
export REPLY='Keep `backticks`, $variables, and newlines
as inert JSON data.'
export RUNBOOK=""
export CONTEXT="deployment sha abc123"

(
  cd "$consumer"
  bash "$action_dir/prepare.sh"
)

context_path="$(sed -n 's/^path=//p' "$GITHUB_OUTPUT")"
protocol_path="$(sed -n 's/^protocol-path=//p' "$GITHUB_OUTPUT")"

test "$context_path" = "$runner_temp/agent-dispatch/context.json"
test "$protocol_path" = "$(realpath "$action_dir/../../../.agents/skills/agent-protocol/agent-protocol.md")"
test "$(find "$consumer" -mindepth 1 -print -quit)" = ""

jq -e \
  --arg reply "$REPLY" \
  '.agent == "Test Agent" and
   .repository == "example/consumer" and
   .anchor.number == "123" and
   .mode == "reply" and
   .reply == $reply and
   .context == "deployment sha abc123"' \
  "$context_path" >/dev/null

grep -Fx "AGENT_DISPATCH_CONTEXT=$context_path" "$GITHUB_ENV" >/dev/null
grep -Fx "AGENT_PROTOCOL_PATH=$protocol_path" "$GITHUB_ENV" >/dev/null

case "$context_path" in
  "$consumer"/*)
    echo "dispatch context leaked into consumer worktree" >&2
    exit 1
    ;;
esac

case "$protocol_path" in
  "$consumer"/*)
    echo "shared protocol leaked into consumer worktree" >&2
    exit 1
    ;;
esac
