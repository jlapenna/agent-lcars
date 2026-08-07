#!/usr/bin/env bash
# Each case below runs in its own `( ... )` subshell so exported overrides
# never leak into the next case; shellcheck can't see across that
# isolation, hence the blanket disable below.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/post-agent-gates.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A fake `gh` on PATH covering every call post-agent-gates.sh's three
# sub-scripts (verify-deliverable.sh, report-failure.sh, and an optional
# FAILURE_LOG_SCAN_SCRIPT) can make: REST lookups, `gh issue comment`, and
# `gh run view --log`. Every call is logged so a case can assert on what
# was (or was not) actually invoked -- e.g. that verify-deliverable's own
# lookups never fire once an earlier gate has already failed the job.
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_GH_DIR/calls"

if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  if [ -f "$FAKE_GH_DIR/comment.fail" ]; then
    echo "fake gh: simulated comment failure" >&2
    exit 1
  fi
  exit 0
fi

if [ "$1" = "run" ] && [ "$2" = "view" ]; then
  if [ -f "$FAKE_GH_DIR/run-log.txt" ]; then
    cat "$FAKE_GH_DIR/run-log.txt"
  fi
  # An empty log is a legitimate response (the run this call is part of
  # can still be in progress) -- never fail this call itself.
  exit 0
fi

if [ "$1" != "api" ]; then
  echo "fake gh: unsupported invocation: $*" >&2
  exit 64
fi
path="$2"
case "$path" in
  *"/reviews?"*) key=reviews ;;
  *"/comments?"*) key=comments ;;
  *"/pulls?"*) key=pulls ;;
  */labels) key=labels ;;
  */assignees) key=assignees ;;
  *"/issues/"*) key=issue ;;
  *)
    echo "fake gh: unrecognized api path: $path" >&2
    exit 64
    ;;
esac

if [ -f "$FAKE_GH_DIR/$key.fail" ]; then
  echo "fake gh: simulated transient failure for $key" >&2
  exit 1
fi

if [ -f "$FAKE_GH_DIR/$key.json" ]; then
  cat "$FAKE_GH_DIR/$key.json"
else
  case "$key" in
    pulls | comments | reviews) echo "[]" ;;
    issue) echo '{"state":"open","closed_at":null,"labels":[],"assignees":[]}' ;;
    labels | assignees) : ;; # -f mutation calls are --silent; no body needed
  esac
fi
FAKE_GH
chmod +x "$fake_bin/gh"
export PATH="$fake_bin:$PATH"

# Common env every case starts from; each case overrides what it needs.
# WRITER_CREDENTIALS_FILE is deliberately left empty: telemetry-finalize.sh
# either cannot find the sidecar wrapper at all, or finds it and stops on the
# missing credentials. Both are non-shipping outcomes, which is what these
# cases want -- see assert_telemetry_finalize_ran for why the branch taken
# depends on where the suite runs.
base_env() {
  export GH_TOKEN=test-token
  export AGENT="Test Agent"
  export REPO=example/consumer
  export SERVER_URL=https://github.com
  export RUN_ID=30749363701
  export ISSUE=42
  export JOB_STATUS=success
  export MAINTAINER=maintainer-login
  export STARTED_AT=2024-01-01T00:00:00Z
  export MODE=implement
  export EXPECTED_COMMENT_LOGIN="agent-lcars[bot]"
  export EXCLUDE_PR_AUTHOR=
  export WRITER_CREDENTIALS_FILE=
  export NO_DELIVERABLE_REASON="LANE_NO_DELIVERABLE_MARKER"
  export FAILURE_LOG_SCAN_SCRIPT=
}

run_case() {
  local name="$1"
  local case_dir="$test_root/$name"
  mkdir -p "$case_dir"
  export FAKE_GH_DIR="$case_dir"
  export GITHUB_ENV="$case_dir/github-env"
  : > "$GITHUB_ENV"
  : > "$FAKE_GH_DIR/calls"
  set +e
  output="$(bash "$script" 2>&1)"
  status=$?
  set -e
  echo "$output" > "$case_dir/output"
}

fail() {
  echo "FAIL: $1" >&2
  echo "--- output ---" >&2
  cat "$FAKE_GH_DIR/output" >&2
  exit 1
}

# telemetry-finalize.sh execs a hardcoded absolute path,
# /usr/local/lib/agent-lcars/sidecar-lifecycle.sh, which this repo bakes into
# its own runner image (apps/runner-autoscaler/runner-image/Dockerfile). So
# which branch it takes depends on where the test runs: absent on a
# workstation ("Sidecar tooling not found"), present on the fleet's runners,
# where it reaches sidecar-lifecycle.sh and stops on the empty
# WRITER_CREDENTIALS_FILE instead. Asserting either single message makes the
# suite pass in one environment and fail in the other -- which it did, silently,
# until an unrelated fix reordered CI enough for this step to finally run.
#
# What these cases actually care about is that telemetry-finalize ran at all,
# and both messages prove exactly that. So accept either, and still fail loudly
# if neither appears -- that is the regression worth catching.
#
# Deliberately not fixed by making the path an env override: post-agent-gates
# runs after the agent step, and agents can write to $GITHUB_ENV, so an
# env-controlled exec path here would hand them arbitrary code execution in a
# later trusted step.
assert_telemetry_finalize_ran() {
  case "$output" in
    *"Sidecar tooling not found"* | *"skipping telemetry finalize"*) ;;
    *) fail "$1" ;;
  esac
}

# --- Case 1: JOB_STATUS success, deliverable found - happy path. No
# comment, no label/assignee mutation, exit 0. Telemetry-finalize's own
# fallback message still appears (if: always() equivalent). ---
(
  base_env
  case_dir="$test_root/success-deliverable-found"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":7,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case success-deliverable-found
  test "$status" = 0 || fail "a found deliverable must exit 0"
  assert_telemetry_finalize_ran "telemetry-finalize must always run, even on the happy path"
  if grep -q 'issue comment' "$FAKE_GH_DIR/calls"; then
    fail "a found deliverable must never post a failure comment"
  fi
)

# --- Case 2: JOB_STATUS success, genuinely no deliverable - NO_DELIVERABLE
# propagates from verify-deliverable.sh's own GITHUB_ENV write into the
# lane-provided NO_DELIVERABLE_REASON text, reported on the issue, exit 1
# (mirrors "Verify a deliverable exists" itself failing the job). ---
(
  base_env
  export MODE=implement
  run_case success-no-deliverable
  test "$status" = 1 || fail "a genuine no-deliverable must exit 1"
  grep -q 'issue comment 42' "$FAKE_GH_DIR/calls" || fail "expected a failure comment"
  # The REASON text lands inside the `gh issue comment ... --body ...`
  # invocation report-failure.sh makes, which the fake gh logs verbatim -
  # it is never echoed to this script's own stdout/stderr.
  grep -q 'LANE_NO_DELIVERABLE_MARKER' "$FAKE_GH_DIR/calls" || fail "expected the lane-provided NO_DELIVERABLE_REASON text in the report"
  grep -q '/issues/42/labels' "$FAKE_GH_DIR/calls" || fail "expected the status:needs-human label mutation"
  grep -q '/issues/42/assignees' "$FAKE_GH_DIR/calls" || fail "expected the maintainer assignment mutation"
)

# --- Case 3: JOB_STATUS success, verify-deliverable's own lookup fails
# (distinct from "no deliverable found") - still exits 1 and still reports,
# but WITHOUT the no-deliverable wording (no FAILURE_LOG_SCAN_SCRIPT set
# either, so REASON is empty - just the bare run-failed message). ---
(
  base_env
  case_dir="$test_root/success-lookup-fails"
  mkdir -p "$case_dir"
  : > "$case_dir/pulls.fail"
  run_case success-lookup-fails
  test "$status" = 1 || fail "a failed deliverable lookup must exit 1"
  grep -q 'issue comment 42' "$FAKE_GH_DIR/calls" || fail "expected a failure comment even on an inconclusive lookup"
  if grep -q 'LANE_NO_DELIVERABLE_MARKER' "$FAKE_GH_DIR/calls"; then
    fail "an inconclusive lookup must not use the no-deliverable wording"
  fi
)

# --- Case 4: JOB_STATUS already failure (an earlier gate, e.g. claude's own
# "Verify Claude run status", already failed the job) - verify-deliverable
# must be skipped entirely (mirrors its original if: success()), and this
# step's own exit stays 0 as long as report-failure itself succeeds
# (mirrors the original "Report failure on the issue" step being able to
# succeed even though the job is already red from an earlier failure). ---
(
  base_env
  export JOB_STATUS=failure
  run_case already-failed
  test "$status" = 0 || fail "already-failed upstream with a landed report must still exit 0"
  if grep -q '/pulls?' "$FAKE_GH_DIR/calls"; then
    fail "verify-deliverable must be skipped once JOB_STATUS is not success"
  fi
  grep -q 'issue comment 42' "$FAKE_GH_DIR/calls" || fail "expected a failure comment"
  if grep -q 'was cancelled' "$FAKE_GH_DIR/calls"; then
    fail "an ordinary failure must not be reported as cancelled"
  fi
)

# --- Case 5: JOB_STATUS cancelled - report-failure.sh's own MSG logic
# distinguishes this from an ordinary failure; JOB_STATUS must reach it
# unchanged. ---
(
  base_env
  export JOB_STATUS=cancelled
  run_case already-cancelled
  test "$status" = 0 || fail "a cancelled run with a landed report must still exit 0"
  grep -q 'was cancelled' "$FAKE_GH_DIR/calls" || fail "expected the cancelled-specific message"
)

# --- Case 6: FAILURE_LOG_SCAN_SCRIPT (claude's adapter-style extra signal)
# supplies REASON text when the job already failed upstream and there is no
# NO_DELIVERABLE case to report instead. ---
(
  base_env
  export JOB_STATUS=failure
  case_dir="$test_root/log-scan-used"
  mkdir -p "$case_dir"
  cat > "$case_dir/scan.sh" <<'SCAN'
#!/usr/bin/env bash
printf '%s' 'EXTRA_LOG_SCAN_MARKER'
SCAN
  chmod +x "$case_dir/scan.sh"
  export FAILURE_LOG_SCAN_SCRIPT="$case_dir/scan.sh"
  run_case log-scan-used
  test "$status" = 0 || fail "log-scan case with a landed report must still exit 0"
  grep -q 'EXTRA_LOG_SCAN_MARKER' "$FAKE_GH_DIR/calls" || fail "expected the lane-provided log-scan script's own REASON text"
)

# --- Case 7: NO_DELIVERABLE takes priority over FAILURE_LOG_SCAN_SCRIPT -
# mirrors the original elif ordering (NO_DELIVERABLE checked before the
# log-scan signatures in claude.yml's own "Determine failure reason"). ---
(
  base_env
  case_dir="$test_root/no-deliverable-wins-over-log-scan"
  mkdir -p "$case_dir"
  cat > "$case_dir/scan.sh" <<'SCAN'
#!/usr/bin/env bash
printf '%s' 'SHOULD_NOT_APPEAR_MARKER'
SCAN
  chmod +x "$case_dir/scan.sh"
  export FAILURE_LOG_SCAN_SCRIPT="$case_dir/scan.sh"
  run_case no-deliverable-wins-over-log-scan
  test "$status" = 1 || fail "a genuine no-deliverable must still exit 1"
  grep -q 'LANE_NO_DELIVERABLE_MARKER' "$FAKE_GH_DIR/calls" || fail "expected the no-deliverable wording to win"
  if grep -q 'SHOULD_NOT_APPEAR_MARKER' "$FAKE_GH_DIR/calls"; then
    fail "the log-scan script must not run once NO_DELIVERABLE is set"
  fi
)

# --- Case 8: report-failure itself fails to land (e.g. the comment post
# errors) - this step must still fail red even though nothing upstream
# (JOB_STATUS, verify-deliverable) forced that on its own, mirroring the
# original "Report failure on the issue" step having no continue-on-error. ---
(
  base_env
  export JOB_STATUS=failure
  case_dir="$test_root/report-failure-itself-fails"
  mkdir -p "$case_dir"
  : > "$case_dir/comment.fail"
  run_case report-failure-itself-fails
  test "$status" = 1 || fail "a failed failure-report must itself exit 1"
)

# --- Case 9: telemetry-finalize's own always()-equivalent behavior holds
# even when nothing else about the run failed. ---
(
  base_env
  export JOB_STATUS=success
  run_case telemetry-runs-on-clean-success
  assert_telemetry_finalize_ran "telemetry-finalize must run unconditionally"
)

# --- Case 10: the real claude-log-scan.sh (not a fake stand-in) detects a
# turn-budget exhaustion from this run's own log and substitutes THIS
# lane's ambient AGENT_LABEL/REDISPATCH_COMMAND (both ordinary job-level
# env vars in claude.yml, inherited by every step including this one). ---
(
  base_env
  export JOB_STATUS=failure
  export AGENT_LABEL=agent:claude
  export REDISPATCH_COMMAND='@claude'
  export FAILURE_LOG_SCAN_SCRIPT="$action_dir/claude-log-scan.sh"
  case_dir="$test_root/claude-log-scan-turn-budget"
  mkdir -p "$case_dir"
  cat > "$case_dir/run-log.txt" <<'LOG'
2024-01-01T00:00:00.0000000Z Reached maximum number of turns (200)
LOG
  run_case claude-log-scan-turn-budget
  test "$status" = 0 || fail "log-scan turn-budget case with a landed report must still exit 0"
  grep -q 'error_max_turns' "$FAKE_GH_DIR/calls" || fail "expected the turn-budget REASON text"
  grep -q 'agent:claude' "$FAKE_GH_DIR/calls" || fail "expected AGENT_LABEL substituted into the turn-budget REASON text"
  grep -q '@claude' "$FAKE_GH_DIR/calls" || fail "expected REDISPATCH_COMMAND substituted into the turn-budget REASON text"
)

# --- Case 11: the real claude-log-scan.sh detects an expired/invalid OAuth
# token from this run's own log. ---
(
  base_env
  export JOB_STATUS=failure
  export FAILURE_LOG_SCAN_SCRIPT="$action_dir/claude-log-scan.sh"
  case_dir="$test_root/claude-log-scan-oauth"
  mkdir -p "$case_dir"
  cat > "$case_dir/run-log.txt" <<'LOG'
{"is_error": true, "total_cost_usd": 0}
LOG
  run_case claude-log-scan-oauth
  test "$status" = 0 || fail "log-scan oauth case with a landed report must still exit 0"
  grep -q 'CLAUDE_CODE_OAUTH_TOKEN has expired' "$FAKE_GH_DIR/calls" || fail "expected the OAuth-token REASON text"
)

echo "post-agent-gates.test.sh: all cases passed"
