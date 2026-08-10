#!/usr/bin/env bash
# #813: report-failure.sh no longer writes GitHub state at all (no comment,
# no status:needs-human, no assignee) -- the hosted finalizer's completion
# callback reports the anchor issue/PR through the projector's one
# idempotent writer instead. These cases assert the new, much smaller
# contract: a `gh` on PATH that fails on ANY invocation proves the script
# genuinely makes none, and the remaining behavior is just the log message
# and required-env validation.
#
# Each case below runs in its own `( ... )` subshell so exported overrides
# never leak into the next case.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/report-failure.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A `gh` on PATH that fails loudly on any invocation at all -- the positive
# proof that report-failure.sh no longer calls it (#813).
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
echo "fake gh: report-failure.sh must not call gh at all: $*" >&2
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
}

fail() {
  echo "FAIL: $1" >&2
  echo "--- output ---" >&2
  echo "$output" >&2
  exit 1
}

# --- Case 1: an ordinary failure logs a notice naming the run, calls no gh
# command, and exits 0. ---
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

echo "report-failure.test.sh: all cases passed"
