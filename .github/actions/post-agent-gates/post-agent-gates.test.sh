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

# A fake `gh` on PATH covering every call post-agent-gates.sh's sub-scripts
# can make: verify-deliverable.sh's REST lookups and an optional
# FAILURE_LOG_SCAN_SCRIPT's `gh run view --log`. Every call is logged so a
# case can assert on what was (or was not) actually invoked -- e.g. that
# verify-deliverable's own lookups never fire once an earlier gate has
# already failed the job. report-failure.sh no longer calls `gh` at all
# (#813) -- its own report-failure.test.sh proves that in isolation; the
# `issue comment`/`labels`/`assignees` branches below stay wired only so a
# case here can assert their ABSENCE (a regression back to a direct write
# would still show up as an unexpected call in $FAKE_GH_DIR/calls).
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
jq_filter=""
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case "${args[$i]}" in
    --paginate) : ;;
    --jq) i=$((i + 1)); jq_filter="${args[$i]}" ;;
  esac
  i=$((i + 1))
done
case "$path" in
  *"/reviews?"*) key=reviews ;;
  *"/comments?"*) key=comments ;;
  *"/pulls?"*) key=pulls ;;
  *"/timeline"*) key=timeline ;;
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
  if [ -n "$jq_filter" ]; then
    jq -r "$jq_filter" < "$FAKE_GH_DIR/$key.json"
  else
    cat "$FAKE_GH_DIR/$key.json"
  fi
else
  case "$key" in
    pulls | comments | reviews | timeline) default='[]' ;;
    issue) default='{"state":"open","closed_at":null,"labels":[],"assignees":[]}' ;;
    labels | assignees) default='' ;; # -f mutation calls are --silent; no body needed
  esac
  if [ -n "$default" ]; then
    if [ -n "$jq_filter" ]; then
      printf '%s' "$default" | jq -r "$jq_filter"
    else
      printf '%s\n' "$default"
    fi
  fi
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
  # MAINTAINER is no longer a post-agent-gates.sh input: report-failure.sh
  # is log-only (#813), and its former standalone direct-park mode was
  # retired per maintainer decision 2026-08-17.
  export MODE=implement
  export ATTEMPT_ID="g1:test-intent"
  export WRITER_CREDENTIALS_FILE=
  export NO_DELIVERABLE_REASON="LANE_NO_DELIVERABLE_MARKER"
  export FAILURE_LOG_SCAN_SCRIPT=
  export CLAUDE_EXECUTION_FILE=
}

run_case() {
  local name="$1"
  local case_dir="$test_root/$name"
  mkdir -p "$case_dir"
  export FAKE_GH_DIR="$case_dir"
  export GITHUB_ENV="$case_dir/github-env"
  export GITHUB_OUTPUT="$case_dir/github-output"
  : > "$GITHUB_ENV"
  : > "$GITHUB_OUTPUT"
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
[{"number":7,"title":"Fix widget (#42)","body":"<!-- attempt-claim:g1:test-intent -->","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case success-deliverable-found
  test "$status" = 0 || fail "a found deliverable must exit 0"
  assert_telemetry_finalize_ran "telemetry-finalize must always run, even on the happy path"
  if grep -q 'issue comment' "$FAKE_GH_DIR/calls"; then
    fail "a found deliverable must never post a failure comment"
  fi
  test ! -s "$GITHUB_OUTPUT" || fail "the gates must publish no step outputs (outcome-kind/-reference were retired 2026-08-17; nothing maps them)"
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
  # #813: report-failure.sh only logs now -- the REASON text lands in its
  # own `::notice::` line on this script's stdout, which run_case captures
  # as $output. It must never reach gh at all: the hosted finalizer's
  # completion callback reports through the projector's one writer instead.
  grep -q 'agent run failed' <<<"$output" || fail "expected the failure logged in this run's own output"
  grep -q 'LANE_NO_DELIVERABLE_MARKER' <<<"$output" || fail "expected the lane-provided NO_DELIVERABLE_REASON text in the log"
  if grep -q '/issues/42/labels' "$FAKE_GH_DIR/calls"; then
    fail "must not write status:needs-human directly (#813)"
  fi
  if grep -q '/issues/42/assignees' "$FAKE_GH_DIR/calls"; then
    fail "must not assign the maintainer directly (#813)"
  fi
  if grep -q 'issue comment' "$FAKE_GH_DIR/calls"; then
    fail "must not post the failure comment directly (#813)"
  fi
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
  grep -q 'agent run failed' <<<"$output" || fail "expected the failure logged even on an inconclusive lookup"
  if grep -q 'LANE_NO_DELIVERABLE_MARKER' <<<"$output"; then
    fail "an inconclusive lookup must not use the no-deliverable wording"
  fi
)

# --- Case 4: JOB_STATUS already failure (an earlier gate, e.g. claude's own
# "Verify Claude run status", already failed the job) - verify-deliverable
# must be skipped entirely (mirrors its original if: success()), and this
# step's own exit stays 0 as long as report-failure itself succeeds
# (mirrors the original "Report failure on the issue" step being able to
# succeed even though the job is already red from an earlier failure).
# The assertion below proves report-failure.sh stays log-only even though
# GH_TOKEN and ISSUE are both ambiently non-empty on this script -- its
# standalone direct-park mode was retired (maintainer decision
# 2026-08-17). ---
(
  base_env
  export JOB_STATUS=failure
  run_case already-failed
  test "$status" = 0 || fail "already-failed upstream with a landed report must still exit 0"
  if grep -q '/pulls?' "$FAKE_GH_DIR/calls"; then
    fail "verify-deliverable must be skipped once JOB_STATUS is not success"
  fi
  if grep -q 'issue comment' "$FAKE_GH_DIR/calls"; then
    fail "hosted mode (MAINTAINER absent) must never post a visible failure comment"
  fi
  grep -q 'agent run failed' <<<"$output" || fail "expected the failure logged"
  if grep -q 'was cancelled' <<<"$output"; then
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
  grep -q 'was cancelled' <<<"$output" || fail "expected the cancelled-specific message"
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
  grep -q 'EXTRA_LOG_SCAN_MARKER' <<<"$output" || fail "expected the lane-provided log-scan script's own REASON text"
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
  grep -q 'LANE_NO_DELIVERABLE_MARKER' <<<"$output" || fail "expected the no-deliverable wording to win"
  if grep -q 'SHOULD_NOT_APPEAR_MARKER' <<<"$output"; then
    fail "the log-scan script must not run once NO_DELIVERABLE is set"
  fi
)

# Case 8 used to prove report-failure.sh's own comment-post failure still
# failed this step red. #813 retired that GitHub write entirely -- log-only
# report-failure.sh has no external call left that can fail, so that
# scenario no longer exists (removed rather than kept as dead coverage).

# --- Case 9: telemetry-finalize's own always()-equivalent behavior holds
# even when nothing else about the run failed. ---
(
  base_env
  export JOB_STATUS=success
  run_case telemetry-runs-on-clean-success
  assert_telemetry_finalize_ran "telemetry-finalize must run unconditionally"
)

# --- Case 10: the real claude-log-scan.sh (not a fake stand-in) detects a
# turn-budget exhaustion from Claude's structured execution file and
# substitutes THIS
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
  export CLAUDE_EXECUTION_FILE="$case_dir/claude-execution-output.json"
  printf '%s\n' '[{"type":"result","subtype":"error_max_turns","is_error":true}]' > "$CLAUDE_EXECUTION_FILE"
  run_case claude-log-scan-turn-budget
  test "$status" = 0 || fail "log-scan turn-budget case with a landed report must still exit 0"
  grep -q 'error_max_turns' <<<"$output" || fail "expected the turn-budget REASON text"
  grep -q 'agent:claude' <<<"$output" || fail "expected AGENT_LABEL substituted into the turn-budget REASON text"
  grep -q '@claude' <<<"$output" || fail "expected REDISPATCH_COMMAND substituted into the turn-budget REASON text"
  if grep -q '^run view ' "$FAKE_GH_DIR/calls"; then
    fail "the structured execution file must avoid the unavailable in-progress run-log API"
  fi
)

# --- Case 11: the real claude-log-scan.sh detects an expired/invalid OAuth
# token from Claude's structured execution file. ---
(
  base_env
  export JOB_STATUS=failure
  export FAILURE_LOG_SCAN_SCRIPT="$action_dir/claude-log-scan.sh"
  case_dir="$test_root/claude-log-scan-oauth"
  mkdir -p "$case_dir"
  export CLAUDE_EXECUTION_FILE="$case_dir/claude-execution-output.json"
  printf '%s\n' '[{"type":"result","subtype":"success","is_error": true,"api_error_status": 401,"total_cost_usd": 0}]' > "$CLAUDE_EXECUTION_FILE"
  run_case claude-log-scan-oauth
  test "$status" = 0 || fail "log-scan oauth case with a landed report must still exit 0"
  grep -q 'CLAUDE_CODE_OAUTH_TOKEN has expired' <<<"$output" || fail "expected the OAuth-token REASON text"
  if grep -q '^run view ' "$FAKE_GH_DIR/calls"; then
    fail "the structured execution file must avoid the unavailable in-progress run-log API"
  fi
)

# --- Case 11b: a zero-cost initialization failure without a positive OAuth
# 401 signal is provider readiness, not a guessed credential rotation. ---
(
  base_env
  export JOB_STATUS=failure
  export FAILURE_LOG_SCAN_SCRIPT="$action_dir/claude-log-scan.sh"
  case_dir="$test_root/claude-log-scan-provider"
  mkdir -p "$case_dir"
  export CLAUDE_EXECUTION_FILE="$case_dir/claude-execution-output.json"
  printf '%s\n' '[{"type":"result","subtype":"success","is_error": true,"total_cost_usd": 0}]' > "$CLAUDE_EXECUTION_FILE"
  run_case claude-log-scan-provider
  test "$status" = 0 || fail "provider-init case with a landed report must still exit 0"
  grep -q 'failed during provider initialization' <<<"$output" || fail "expected the provider-init REASON text"
  if grep -q 'CLAUDE_CODE_OAUTH_TOKEN has expired' <<<"$output"; then
    fail "a generic zero-cost failure must not guess that the OAuth token expired"
  fi
)

# --- Case 12: MAINTAINER no longer opts into any standalone direct-park
# path (retired per maintainer decision 2026-08-17) - even with the full
# former opt-in tuple ambiently present (GH_TOKEN and ISSUE from base_env),
# report-failure.sh stays log-only and writes no GitHub state. ---
(
  base_env
  export JOB_STATUS=failure
  export MAINTAINER=octocat
  run_case retired-maintainer-ignored
  test "$status" = 0 || fail "a landed log-only report must still exit 0"
  grep -q 'agent run failed' <<<"$output" || fail "expected the failure logged"
  if grep -q 'issue comment' "$FAKE_GH_DIR/calls"; then
    fail "the retired MAINTAINER toggle must not resurrect the direct failure comment"
  fi
  if grep -q '/issues/42/labels' "$FAKE_GH_DIR/calls"; then
    fail "the retired MAINTAINER toggle must not write status:needs-human directly"
  fi
  if grep -q '/issues/42/assignees' "$FAKE_GH_DIR/calls"; then
    fail "the retired MAINTAINER toggle must not assign the maintainer directly"
  fi
)

# --- Case 15: ATTEMPT_ID is required for the verify phase, with no legacy
# fallback - the #1208 Phase 2/#1237 optionality (legacy STARTED_AT +
# EXPECTED_COMMENT_LOGIN inference pair substituting for ATTEMPT_ID) was
# deleted once every fleet consumer passed ATTEMPT_ID. A consumer that
# still passes only the legacy pair must fail closed with a named
# diagnostic, and verify-deliverable's lookups must never fire. ---
(
  base_env
  unset ATTEMPT_ID
  export STARTED_AT=2024-01-01T00:00:00Z
  export EXPECTED_COMMENT_LOGIN='agent-lcars[bot]'
  case_dir="$test_root/legacy-pair-no-longer-substitutes"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":9,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case legacy-pair-no-longer-substitutes
  test "$status" != 0 || fail "the legacy inference pair must no longer substitute for ATTEMPT_ID"
  grep -q 'ATTEMPT_ID is required' <<<"$output" || \
    fail "expected the named ATTEMPT_ID diagnostic"
  if grep -q '/pulls?' "$FAKE_GH_DIR/calls"; then
    fail "verify-deliverable's lookups must never fire without ATTEMPT_ID"
  fi
)

# --- Case 16: ATTEMPT_ID missing entirely (no legacy env either) - the
# same hard failure, proving the requirement is unconditional when
# JOB_STATUS is success. ---
(
  base_env
  unset ATTEMPT_ID
  run_case missing-attempt-id
  test "$status" != 0 || fail "missing ATTEMPT_ID must fail closed"
  grep -q 'ATTEMPT_ID is required' <<<"$output" || \
    fail "expected the named ATTEMPT_ID diagnostic"
)


# --- Case 17: push-credential-log-scan.sh detects the opaque git-push
# authentication failure a mid-step App-token expiry produces and
# supplements the failure report with a legible explanation (#1217). ---
(
  base_env
  export JOB_STATUS=failure
  export FAILURE_LOG_SCAN_SCRIPT="$action_dir/push-credential-log-scan.sh"
  case_dir="$test_root/push-credential-log-scan-expired"
  mkdir -p "$case_dir"
  export FAKE_GH_DIR="$case_dir"
  printf '%s\n' "fatal: could not read Username for 'https://github.com': No such device or address" > "$case_dir/run-log.txt"
  run_case push-credential-log-scan-expired
  test "$status" = 0 || fail "log-scan push-credential case with a landed report must still exit 0"
  grep -q 'installation token expiring mid-step' <<<"$output" || fail "expected the push-credential-expiry REASON text"
  grep -q 'agent-lcars#1217' <<<"$output" || fail "expected the REASON text to cite #1217"
)

# --- Case 18: push-credential-log-scan.sh stays silent on an unrelated
# failure signature - it must not guess credential expiry from any
# authentication-shaped text. ---
(
  base_env
  export JOB_STATUS=failure
  export FAILURE_LOG_SCAN_SCRIPT="$action_dir/push-credential-log-scan.sh"
  case_dir="$test_root/push-credential-log-scan-unrelated"
  mkdir -p "$case_dir"
  export FAKE_GH_DIR="$case_dir"
  printf '%s\n' "Error: some unrelated step failure" > "$case_dir/run-log.txt"
  run_case push-credential-log-scan-unrelated
  test "$status" = 0 || fail "log-scan unrelated-failure case with a landed report must still exit 0"
  if grep -q 'installation token expiring mid-step' <<<"$output"; then
    fail "an unrelated failure signature must not produce the push-credential-expiry REASON text"
  fi
)

# --- Case 19: a native run (WORK, no ISSUE) must not die on the top-level
# `ISSUE:?ISSUE is required` guard this script used to have -- ISSUE is
# optional now (Task 3, native work items): forwarded unchanged to
# telemetry-finalize.sh (already anchor-agnostic), and report-failure.sh
# takes no ISSUE input at all (#813), so a native failure logs exactly like
# an issue-anchored one. JOB_STATUS=success + native is covered by Cases
# 20-21 below. ---
(
  base_env
  export ISSUE=
  export JOB_STATUS=failure
  run_case native-no-issue
  test "$status" = 0 || fail "a native failure with a landed report must still exit 0"
  assert_telemetry_finalize_ran "telemetry-finalize must still run for a native (issue-less) run"
  grep -q 'agent run failed' <<<"$output" || fail "expected the failure logged for a native run"
  if grep -q 'ISSUE is required' <<<"$output"; then
    fail "ISSUE must be optional now that native (work-anchored) runs pass it empty"
  fi
)

# --- Case 20: a native run (ISSUE='') + JOB_STATUS=success with a bot PR
# carrying this run's attempt-claim marker -- verify-deliverable.sh's
# PR-marker lookup is the only lookup that ever runs when NUM is empty (no
# issue/PR number to fetch comments or reviews against, see
# verify-deliverable.sh). Exit 0, exactly one gh call (the /pulls lookup),
# and no /issues/ call. ---
(
  base_env
  export ISSUE=
  case_dir="$test_root/native-success-deliverable-found"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":9,"title":"Fix widget","body":"<!-- attempt-claim:g1:test-intent -->","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case native-success-deliverable-found
  test "$status" = 0 || fail "a native run with a found deliverable must exit 0"
  call_count="$(wc -l < "$FAKE_GH_DIR/calls")"
  test "$call_count" = 1 || fail "expected exactly one gh call for a native success run, got $call_count: $(cat "$FAKE_GH_DIR/calls")"
  grep -q '/pulls?' "$FAKE_GH_DIR/calls" || fail "expected the one call to be the /pulls lookup"
  if grep -q '/issues/' "$FAKE_GH_DIR/calls"; then
    fail "a native run has no issue/PR number to anchor an /issues/ call against"
  fi
)

# --- Case 21: same native (ISSUE='') + JOB_STATUS=success, but no PR
# carries the marker -- non-zero exit, NO_DELIVERABLE=1 written by
# verify-deliverable.sh, and still no /issues/ call (there is no NUM to
# anchor one against). ---
(
  base_env
  export ISSUE=
  run_case native-success-no-deliverable
  test "$status" = 1 || fail "a native run with no deliverable must exit non-zero"
  grep -qx 'NO_DELIVERABLE=1' "$GITHUB_ENV" || fail "expected NO_DELIVERABLE=1 written to GITHUB_ENV"
  grep -q 'agent run failed' <<<"$output" || fail "expected the failure logged for a native run with no deliverable"
  if grep -q '/issues/' "$FAKE_GH_DIR/calls"; then
    fail "a native run has no issue/PR number to anchor an /issues/ call against"
  fi
)

echo "post-agent-gates.test.sh: all cases passed"
