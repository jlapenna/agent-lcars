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
export GITHUB_WORKSPACE="$consumer"
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
   .runtime.checkpoints.finalize_by == "2026-08-08T00:45:00Z" and
   .runtime.projections == false' \
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

# CONTROL_PLANE_PROJECTIONS=true (sub-project 5) threads through to
# runtime.projections; the default (unset, asserted above) stays false.
projections_root="$test_root/projections"
mkdir -p "$projections_root/runner-temp" "$projections_root/consumer"
RUNNER_TEMP="$projections_root/runner-temp"
GITHUB_ENV="$projections_root/github-env"
GITHUB_OUTPUT="$projections_root/github-output"
export RUNNER_TEMP GITHUB_ENV GITHUB_OUTPUT
(
  cd "$projections_root/consumer"
  CONTROL_PLANE_PROJECTIONS=true \
    GITHUB_WORKSPACE="$projections_root/consumer" \
    bash "$action_dir/prepare.sh"
)
projections_context_path="$RUNNER_TEMP/agent-dispatch/context.json"
jq -e '.runtime.projections == true' "$projections_context_path" >/dev/null

# An invalid CONTROL_PLANE_PROJECTIONS value fails the dispatch outright,
# matching the malformed-WORK failure mode below.
projections_invalid_output="$test_root/projections-invalid-output"
set +e
(
  cd "$projections_root/consumer"
  CONTROL_PLANE_PROJECTIONS="yes" \
    RUNNER_TEMP="$projections_root/runner-temp" \
    GITHUB_ENV="$projections_root/github-env" \
    GITHUB_OUTPUT="$projections_root/github-output" \
    GITHUB_WORKSPACE="$projections_root/consumer" \
    bash "$action_dir/prepare.sh" > "$projections_invalid_output" 2>&1
)
projections_invalid_status=$?
set -e
test "$projections_invalid_status" -ne 0 || {
  echo "an invalid CONTROL_PLANE_PROJECTIONS must fail the dispatch, not succeed" >&2
  exit 1
}
grep -q '::error::CONTROL_PLANE_PROJECTIONS must be' "$projections_invalid_output" || {
  echo "expected a named ::error:: for an invalid CONTROL_PLANE_PROJECTIONS" >&2
  cat "$projections_invalid_output" >&2
  exit 1
}

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
  GITHUB_WORKSPACE="$oversized_root/consumer" bash "$action_dir/prepare.sh"
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

# A native work-item dispatch (WORK set, ISSUE empty): the anchor is built
# from WORK alone, with no GitHub read of any kind. The fake `gh` below logs
# every invocation and fails loudly, so any accidental `gh api` call in this
# path is caught rather than silently succeeding against a stray fixture.
native_root="$test_root/native"
mkdir -p "$native_root/runner-temp" "$native_root/consumer"

gh_call_log="$native_root/gh-calls.log"
: > "$gh_call_log"
native_bin="$native_root/bin"
mkdir -p "$native_bin"
cat > "$native_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
echo "$*" >> "$GH_CALL_LOG"
echo "unexpected gh call for a native work-item dispatch: $*" >&2
exit 64
FAKE_GH
chmod +x "$native_bin/gh"

WORK='{"id":"01J5Z3K9QX8F0N2B4V6C8D1E3G","spec":{"title":"Add healthz","description":"Expose GET /healthz.","pipeline":"claude","target":{"repo":"octo/example"}}}'
ISSUE=""
MODE="implement"
REPLY=""
CONTEXT=""
CONSOLE_URL="https://lcars.test"
GH_CALL_LOG="$gh_call_log"
RUNNER_TEMP="$native_root/runner-temp"
GITHUB_ENV="$native_root/github-env"
GITHUB_OUTPUT="$native_root/github-output"
export WORK ISSUE MODE REPLY CONTEXT CONSOLE_URL GH_CALL_LOG RUNNER_TEMP GITHUB_ENV GITHUB_OUTPUT

(
  cd "$native_root/consumer"
  GITHUB_WORKSPACE="$native_root/consumer" PATH="$native_bin:$PATH" bash "$action_dir/prepare.sh"
)

if [ -s "$gh_call_log" ]; then
  echo "native work-item dispatch made a gh call: $(cat "$gh_call_log")" >&2
  exit 1
fi

native_context_path="$RUNNER_TEMP/agent-dispatch/context.json"
jq -e '
  .anchor.type == "work" and
  .anchor.id == "01J5Z3K9QX8F0N2B4V6C8D1E3G" and
  .anchor.title == "Add healthz" and
  .anchor.body == "Expose GET /healthz." and
  .anchor.target_repo == "octo/example" and
  .anchor.html_url == "https://lcars.test/work/01J5Z3K9QX8F0N2B4V6C8D1E3G" and
  .anchor.number == null and
  .anchor.labels == [] and
  .anchor.assignees == [] and
  .anchor.state == "open" and
  .anchor.state_reason == null and
  .mode == "implement" and
  .reply == "" and
  .latest_agent_result == null and
  .requested_results == ["pull-request"] and
  .truncated == []' "$native_context_path" >/dev/null

# A GitHub-anchored task that carries a work payload (WORK and ISSUE both
# set, sub-project 5): the brief's title/body come from WORK.spec, but its
# number/html_url/labels/assignees/state still come from the live issue --
# and, critically, `type` is not hardcoded here, so a PR-backed anchor
# still resolves "pull-request" through the same fallback the legacy
# (no-WORK) branch already relies on.
work_and_issue_root="$test_root/work-and-issue"
mkdir -p "$work_and_issue_root/runner-temp" "$work_and_issue_root/consumer"

wi_bin="$work_and_issue_root/bin"
mkdir -p "$wi_bin"
WI_ANCHOR="$work_and_issue_root/anchor.json"
WI_COMMENTS="$work_and_issue_root/comments.json"
cat > "$wi_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = api
case "$2" in
  */comments*) cat "$WI_COMMENTS" ;;
  */issues/42) cat "$WI_ANCHOR" ;;
  *) echo "unexpected gh api path: $2" >&2; exit 64 ;;
esac
FAKE_GH
chmod +x "$wi_bin/gh"

# The live issue's own title/body deliberately DIFFER from WORK.spec, to
# prove the brief uses the WORK snapshot, not this live read.
cat > "$WI_ANCHOR" <<'JSON'
{"number":42,"state":"open","state_reason":null,"title":"Live title (stale)","body":"Live body (stale)","labels":[{"name":"agent:claude"}],"assignees":[{"login":"agent-lcars-bot"}],"html_url":"https://github.com/jlapenna/agent-lcars/issues/42"}
JSON
echo '[]' > "$WI_COMMENTS"

WORK='{"spec":{"title":"Snapshot title","description":"Snapshot body","pipeline":"claude","target":{"repo":"jlapenna/agent-lcars"}}}'
ISSUE="42"
MODE="implement"
REPLY=""
CONTEXT=""
RUNNER_TEMP="$work_and_issue_root/runner-temp"
GITHUB_ENV="$work_and_issue_root/github-env"
GITHUB_OUTPUT="$work_and_issue_root/github-output"
# GITHUB_REPOSITORY deliberately stays the file-wide "example/consumer"
# (not "jlapenna/agent-lcars" as in the task brief's literal fixture):
# assert-consumer-boundaries.sh applies a stricter, unrelated check -- a
# real .agents/skills/agent-protocol symlink into this repo's own
# agents/shared/skills/ -- only for that exact repository name, which this
# mktemp consumer workspace does not have. Every other section in this file
# relies on the same "example/consumer" default for the same reason.
export WORK ISSUE MODE REPLY CONTEXT RUNNER_TEMP GITHUB_ENV GITHUB_OUTPUT \
  WI_ANCHOR WI_COMMENTS

(
  cd "$work_and_issue_root/consumer"
  GITHUB_WORKSPACE="$work_and_issue_root/consumer" PATH="$wi_bin:$PATH" \
    bash "$action_dir/prepare.sh"
)

wi_context_path="$RUNNER_TEMP/agent-dispatch/context.json"
jq -e '
  .anchor.type == "issue" and
  .anchor.number == 42 and
  .anchor.title == "Snapshot title" and
  .anchor.body == "Snapshot body" and
  .anchor.labels == ["agent:claude"] and
  .anchor.assignees == ["agent-lcars-bot"] and
  .anchor.html_url == "https://github.com/jlapenna/agent-lcars/issues/42" and
  .anchor.id == null and
  .runtime.projections == false' "$wi_context_path" >/dev/null

# Same GitHub-anchored-work fixture, but with CONTROL_PLANE_PROJECTIONS=true:
# the brief's runtime.projections must flip to true even on this branch.
(
  cd "$work_and_issue_root/consumer"
  CONTROL_PLANE_PROJECTIONS=true \
    GITHUB_WORKSPACE="$work_and_issue_root/consumer" PATH="$wi_bin:$PATH" \
    bash "$action_dir/prepare.sh"
)

jq -e '.runtime.projections == true' "$wi_context_path" >/dev/null

# Same fixture, but the live issue IS a pull request (`pull_request` key
# present): the brief must still resolve "pull-request", proving the new
# branch does not hardcode `type: "issue"`.
cat > "$WI_ANCHOR" <<'JSON'
{"number":42,"state":"open","state_reason":null,"title":"Live title (stale)","body":"Live body (stale)","labels":[],"assignees":[],"html_url":"https://github.com/jlapenna/agent-lcars/pull/42","pull_request":{"url":"https://api.github.com/repos/jlapenna/agent-lcars/pulls/42"}}
JSON

(
  cd "$work_and_issue_root/consumer"
  GITHUB_WORKSPACE="$work_and_issue_root/consumer" PATH="$wi_bin:$PATH" \
    bash "$action_dir/prepare.sh"
)

jq -e '.anchor.type == "pull-request" and .runtime.projections == false' "$wi_context_path" >/dev/null

echo "prepare.test.sh: work-and-issue anchor cases passed"

# A malformed WORK payload is a caller bug, not a retryable condition: fail
# fast with a named error rather than writing a half-built anchor.
malformed_root="$test_root/malformed"
mkdir -p "$malformed_root/runner-temp" "$malformed_root/consumer"
malformed_output="$test_root/malformed-output"
set +e
(
  cd "$malformed_root/consumer"
  WORK='{"id":"01J5Z3K9QX8F0N2B4V6C8D1E3G","spec":{"description":"missing title and target"}}' \
    ISSUE="" MODE="implement" REPLY="" CONTEXT="" CONSOLE_URL="https://lcars.test" \
    GH_CALL_LOG="$gh_call_log" RUNNER_TEMP="$malformed_root/runner-temp" \
    GITHUB_ENV="$malformed_root/github-env" GITHUB_OUTPUT="$malformed_root/github-output" \
    GITHUB_WORKSPACE="$malformed_root/consumer" PATH="$native_bin:$PATH" \
    bash "$action_dir/prepare.sh" > "$malformed_output" 2>&1
)
malformed_status=$?
set -e
test "$malformed_status" -ne 0 || {
  echo "a malformed WORK payload must fail the dispatch, not succeed" >&2
  exit 1
}
grep -q '::error::WORK is malformed' "$malformed_output" || {
  echo "expected a named ::error:: for a malformed WORK payload" >&2
  cat "$malformed_output" >&2
  exit 1
}

echo "prepare.test.sh: native work anchor cases passed"
