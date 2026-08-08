#!/usr/bin/env bash

set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

consumer="$test_root/consumer"
runner_temp="$test_root/runner-temp"
mkdir -p "$consumer" "$runner_temp"

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = api
case "$2" in
  */comments*) cat "$FAKE_COMMENTS" ;;
  */issues/123) cat "$FAKE_ANCHOR" ;;
  *) echo "unexpected gh api path: $2" >&2; exit 64 ;;
esac
FAKE_GH
chmod +x "$fake_bin/gh"
export PATH="$fake_bin:$PATH"

FAKE_ANCHOR="$test_root/anchor.json"
FAKE_COMMENTS="$test_root/comments.json"
export FAKE_ANCHOR FAKE_COMMENTS
cat > "$FAKE_ANCHOR" <<'JSON'
{"number":123,"state":"open","state_reason":null,"title":"Fix dispatch reliability","body":"## Acceptance\n- [ ] Preserve exact state\n- [x] Keep inert data","labels":[{"name":"agent:codex"}],"assignees":[{"login":"jclaw-bot"}],"html_url":"https://github.com/example/consumer/issues/123"}
JSON
cat > "$FAKE_COMMENTS" <<'JSON'
[{"id":7,"html_url":"https://example.test/comments/7","created_at":"2026-08-08T00:00:00Z","updated_at":"2026-08-08T00:00:00Z","user":{"login":"agent-lcars[bot]"},"body":"NO-OP: already fixed\n<!-- agent-result:v1:no-op -->\n<!-- attempt-claim:g1:abc -->"}]
JSON

export GITHUB_ACTION_PATH="$action_dir"
export GITHUB_ENV="$test_root/github-env"
export GITHUB_OUTPUT="$test_root/github-output"
export GITHUB_REPOSITORY="example/consumer"
export GH_TOKEN="test-token"
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
export PRIOR_TERMINAL_STATE='{"generation":1,"state":"completed","outcome":"no-op"}'
export BUDGET_MINUTES=60
export ARTIFACT_CHECKPOINT_MINUTES=25
export FINALIZE_CHECKPOINT_MINUTES=45
export NOW_EPOCH=1786147200

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
   .schema == 2 and
   .repository == "example/consumer" and
   .anchor.number == 123 and
   .anchor.type == "issue" and
   .anchor.state == "open" and
   .anchor.title == "Fix dispatch reliability" and
   .anchor.labels == ["agent:codex"] and
   .anchor.assignees == ["jclaw-bot"] and
   .anchor.acceptance_criteria == ["Preserve exact state", "Keep inert data"] and
   .mode == "reply" and
   .reply == $reply and
   .context == "deployment sha abc123" and
   .prior_terminal_state.outcome == "no-op" and
   .latest_agent_result.id == 7 and
   .requested_results == ["comment", "pull-request", "park", "no-op"] and
   .runtime.started_at == "2026-08-08T00:00:00Z" and
   .runtime.deadline == "2026-08-08T01:00:00Z" and
   .runtime.checkpoints.durable_artifact_by == "2026-08-08T00:25:00Z" and
   .runtime.checkpoints.finalize_by == "2026-08-08T00:45:00Z"' \
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
