#!/usr/bin/env bash
# #813 keeps failure reporting log-only: the hosted finalizer/orchestrator
# is the one writer of visible failure state. The former standalone
# direct-park mode (#4388's GH_TOKEN/ISSUE_NUM/MAINTAINER tuple) was
# retired per maintainer decision 2026-08-17, so these cases prove the
# script logs, never calls gh, and honors its message inputs.
#
# Each case below runs in its own `( ... )` subshell so exported overrides
# never leak into the next case.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/report-failure.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A fake `gh` records every call so cases can assert its ABSENCE — a
# regression back to a direct GitHub write would surface here.
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${FAKE_GH_CALLS:?FAKE_GH_CALLS is required}"
exit 0
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
  export FAKE_GH_CALLS="$test_root/calls"
  : > "$FAKE_GH_CALLS"
}

fail() {
  echo "FAIL: $1" >&2
  echo "--- output ---" >&2
  echo "$output" >&2
  exit 1
}

# --- Case 1: an ordinary failure logs, calls no gh, and exits 0. ---
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
  test ! -s "$FAKE_GH_CALLS" || fail "log-only reporting must not call gh"
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

# --- Case 5: the retired standalone tuple no longer opts into any direct
# write — even fully supplied, the script stays log-only and calls no gh. ---
(
  base_env
  export GH_TOKEN=test-token
  export ISSUE_NUM=42
  export MAINTAINER=maintainer-login
  output="$(bash "$script" 2>&1)"
  status=$?
  test "$status" = 0 || fail "the retired tuple must not change the exit status"
  case "$output" in
    *"::notice::"*"Test Agent agent run failed:"*) ;;
    *) fail "expected the ordinary log-only notice despite the retired tuple" ;;
  esac
  test ! -s "$FAKE_GH_CALLS" || fail "the retired tuple must not resurrect a direct gh write"
)

echo "report-failure.test.sh: all cases passed"
