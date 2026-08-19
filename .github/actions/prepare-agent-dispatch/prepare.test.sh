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
{"number":123,"state":"open","state_reason":null,"title":"Fix dispatch reliability","body":"## Acceptance\n- [ ] Preserve exact state\n- [x] Keep inert data","labels":[{"name":"agent:codex"}],"assignees":[{"login":"agent-lcars-bot"}],"html_url":"https://github.com/example/consumer/issues/123"}
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
test "$protocol_path" = "$(realpath "$action_dir/../../../agents/shared/skills/agent-protocol/reference/agent-protocol.md")"
test "$(find "$consumer" -mindepth 1 -print -quit)" = ""

jq -e \
  --arg reply "$REPLY" \
  '.agent == "Test Agent" and
   .schema == 3 and
   .repository == "example/consumer" and
   .anchor.number == 123 and
   .anchor.type == "issue" and
   .anchor.state == "open" and
   .anchor.title == "Fix dispatch reliability" and
   .anchor.labels == ["agent:codex"] and
   .anchor.assignees == ["agent-lcars-bot"] and
   .anchor.acceptance_criteria == ["Preserve exact state", "Keep inert data"] and
   .truncated == [] and
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

# A brief built from oversized GitHub content must stay bounded. The budgets
# are constants in prepare.sh, so this exercises the real shipped values
# rather than a lowered test-only limit: the fixtures below are sized against
# them, and a budget change here fails loudly instead of silently passing.
oversized_root="$test_root/oversized"
mkdir -p "$oversized_root/runner-temp" "$oversized_root/consumer"

long_line="$(printf 'x%.0s' $(seq 1 200))"
long_body="## Acceptance"$'\n'
for i in $(seq 1 60); do
  long_body+="- [ ] criterion $i"$'\n'
done
for _ in $(seq 1 60); do
  long_body+="$long_line"$'\n'
done

FAKE_ANCHOR="$oversized_root/anchor.json"
FAKE_COMMENTS="$oversized_root/comments.json"
export FAKE_ANCHOR FAKE_COMMENTS
jq -n --arg body "$long_body" \
  '{number:123,state:"open",state_reason:null,title:"Oversized",body:$body,
    labels:[],assignees:[],html_url:"https://example.test/issues/123"}' \
  > "$FAKE_ANCHOR"
long_comment="<!-- attempt-claim:g1:abc -->"$'\n'"$(printf 'y%.0s' $(seq 1 9000))"
jq -n --arg body "$long_comment" \
  '[{id:9,html_url:"https://example.test/comments/9",created_at:"2026-08-08T00:00:00Z",
     updated_at:"2026-08-08T00:00:00Z",user:{login:"agent-lcars[bot]"},body:$body}]' \
  > "$FAKE_COMMENTS"

RUNNER_TEMP="$oversized_root/runner-temp"
GITHUB_ENV="$oversized_root/github-env"
GITHUB_OUTPUT="$oversized_root/github-output"
REPLY="$(printf 'r%.0s' $(seq 1 9000))"
CONTEXT="$(printf 'c%.0s' $(seq 1 9000))"
export RUNNER_TEMP GITHUB_ENV GITHUB_OUTPUT REPLY CONTEXT

(
  cd "$oversized_root/consumer"
  bash "$action_dir/prepare.sh"
)

oversized_path="$RUNNER_TEMP/agent-dispatch/context.json"

# Every clamped field lands at its budget plus this action's own truncation
# marker, and every one of them is named in `truncated` so the agent knows to
# fetch the rest rather than assuming it read the whole thing.
jq -e '
  (.anchor.body | startswith("## Acceptance")) and
  (.anchor.body | contains("[dispatch-brief: truncated to 6000 of ")) and
  (.anchor.body | contains("https://example.test/issues/123")) and
  (.reply | contains("[dispatch-brief: truncated to 4000 of 9000 characters.")) and
  (.context | contains("[dispatch-brief: truncated to 2000 of 9000 characters.")) and
  (.latest_agent_result.body | contains("[dispatch-brief: truncated to 2000 of ")) and
  (.latest_agent_result.body | contains("https://example.test/comments/9")) and
  ((.anchor.acceptance_criteria | length) == 40) and
  # Criteria are extracted from the full body, so ones past the body budget
  # still survive - truncating the prose must not silently drop the checklist.
  (.anchor.acceptance_criteria[39] == "criterion 40") and
  (.truncated | sort) == [
    "anchor.acceptance_criteria", "anchor.body", "context",
    "latest_agent_result.body", "reply"
  ]' "$oversized_path" >/dev/null

# The whole brief stays within a predictable ceiling no matter how large the
# thread was: this is the property the budget exists to guarantee.
oversized_bytes="$(wc -c < "$oversized_path")"
if [ "$oversized_bytes" -gt 20000 ]; then
  echo "dispatch brief exceeded its size budget: $oversized_bytes bytes" >&2
  exit 1
fi
