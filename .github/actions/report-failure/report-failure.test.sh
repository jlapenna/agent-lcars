#!/usr/bin/env bash
# #813 keeps LCARS's hosted-projector path log-only. #4388 adds an explicit
# standalone-consumer compatibility path when MAINTAINER, GH_TOKEN, and
# ISSUE_NUM are present. These cases prove both modes stay isolated.
#
# Each case below runs in its own `( ... )` subshell so exported overrides
# never leak into the next case.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/report-failure.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A fake `gh` records every call and accepts exactly the standalone reporter's
# comment/label/assignee operations.
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${FAKE_GH_CALLS:?FAKE_GH_CALLS is required}"
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$2" in
    */labels|*/assignees) exit 0 ;;
  esac
fi
echo "fake gh: unsupported invocation: $*" >&2
exit 64
FAKE_GH
chmod +x "$fake_bin/gh"
export PATH="$fake_bin:$PATH"

base_env() {
  export AGENT="Test Agent"
  export REPO=example/consumer
  export SERVER_URL=https://github.com
  export RUN_ID=30749363701
  export JOB_STATUS=failure
  export MESSAGE_PREFIX=""
  export REASON=""
  unset GH_TOKEN ISSUE_NUM MAINTAINER
  export FAKE_GH_CALLS="$test_root/calls"
  : > "$FAKE_GH_CALLS"
}

fail() {
  echo "FAIL: $1" >&2
  echo "--- output ---" >&2
  echo "$output" >&2
  exit 1
}

# --- Case 1: LCARS hosted-finalizer mode logs, calls no gh, and exits 0. ---
(
  base_env
  output="$(bash "$script" 2>&1)"
  status=$?
  test "$status" = 0 || fail "an ordinary failure must exit 0"
  case "$output" in
    *"::notice::"*"Test Agent agent run failed:"*"actions/runs/30749363701"*) ;;
    *) fail "expected a ::notice:: naming the agent, 'failed', and the run URL" ;;
  esac
  case "$output" in
    *"::error::"*) fail "must not log an error on the ordinary path" ;;
  esac
  test ! -s "$FAKE_GH_CALLS" || fail "hosted-finalizer mode must not call gh"
)

# --- Case 2: JOB_STATUS=cancelled renders the timeout-specific wording. ---
(
  base_env
  export JOB_STATUS=cancelled
  output="$(bash "$script" 2>&1)"
  status=$?
  test "$status" = 0 || fail "a cancelled job must exit 0"
  case "$output" in
    *"was cancelled (likely hit the job's timeout-minutes limit)"*) ;;
    *) fail "expected the timeout-specific cancellation wording" ;;
  esac
)

# --- Case 3: MESSAGE_PREFIX and REASON are honored verbatim in the log. ---
(
  base_env
  export MESSAGE_PREFIX=":rotating_light: "
  export REASON=$'\n\nSome extra context.'
  output="$(bash "$script" 2>&1)"
  status=$?
  test "$status" = 0 || fail "must still exit 0 with a prefix and reason"
  case "$output" in
    *":rotating_light: Test Agent agent run failed:"*"Some extra context."*) ;;
    *) fail "expected the prefix and reason to appear in the log line" ;;
  esac
)

# --- Case 4: a missing required var still fails closed via bash's own :?
# validation, unchanged from before. ---
(
  base_env
  unset JOB_STATUS
  set +e
  output="$(bash "$script" 2>&1)"
  status=$?
  set -e
  test "$status" != 0 || fail "a missing required var must not silently succeed"
  case "$output" in
    *"JOB_STATUS is required"*) ;;
    *) fail "expected the :? validation message naming JOB_STATUS" ;;
  esac
)

# --- Case 5: a standalone consumer supplies the complete opt-in tuple and
# gets the visible comment plus additive label/assignee parking writes. ---
(
  base_env
  export GH_TOKEN=test-token
  export ISSUE_NUM=42
  export MAINTAINER=maintainer-login
  output="$(bash "$script" 2>&1)"
  status=$?
  test "$status" = 0 || fail "standalone reporting must exit 0"
  grep -q 'issue comment 42' "$FAKE_GH_CALLS" || fail "expected a failure comment"
  grep -q 'issues/42/labels' "$FAKE_GH_CALLS" || fail "expected status:needs-human"
  grep -q 'issues/42/assignees' "$FAKE_GH_CALLS" || fail "expected maintainer assignment"
)

# --- Case 6: MAINTAINER is the explicit opt-in. A partial tuple fails closed
# instead of logging a misleading hosted-finalizer handoff. ---
(
  base_env
  export MAINTAINER=maintainer-login
  set +e
  output="$(bash "$script" 2>&1)"
  status=$?
  set -e
  test "$status" != 0 || fail "partial standalone inputs must fail"
  case "$output" in
    *"GH_TOKEN is required when MAINTAINER enables standalone reporting"*) ;;
    *) fail "expected the missing GH_TOKEN diagnostic" ;;
  esac
  test ! -s "$FAKE_GH_CALLS" || fail "partial inputs must not call gh"
)

echo "report-failure.test.sh: all cases passed"
