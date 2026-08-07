#!/usr/bin/env bash
# Each case below runs in its own `( ... )` subshell so exported overrides
# never leak into the next case; shellcheck can't see across that
# isolation, hence the blanket disable below.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/canary-alert.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A fake `gh` on PATH: dispatches on the subcommand/REST path requested and
# answers from JSON fixtures under $FAKE_GH_DIR, or simulates a transient
# failure when a `<key>.fail` marker file is present. Every call is also
# logged so a case can assert on what was actually invoked (and, just as
# important here, what was NOT invoked - e.g. no second issue, no mutation
# after a failed lookup). `--jq` filters are run for real against the
# fixture (same convention as verify-deliverable.test.sh's fake gh) so a
# case exercises the script's actual jq expressions, not a stub that
# quietly ignores them.
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_GH_DIR/calls"

if [ "$1" = "issue" ]; then
  case "$2" in
    close)
      if [ -f "$FAKE_GH_DIR/close.fail" ]; then
        echo "fake gh: simulated close failure" >&2
        exit 1
      fi
      exit 0
      ;;
    comment)
      if [ -f "$FAKE_GH_DIR/comment.fail" ]; then
        echo "fake gh: simulated comment failure" >&2
        exit 1
      fi
      exit 0
      ;;
    create)
      if [ -f "$FAKE_GH_DIR/create.fail" ]; then
        echo "fake gh: simulated create failure" >&2
        exit 1
      fi
      echo "https://github.com/example/consumer/issues/999"
      exit 0
      ;;
    *)
      echo "fake gh: unsupported issue subcommand: $*" >&2
      exit 64
      ;;
  esac
fi

if [ "$1" != "api" ]; then
  echo "fake gh: unsupported invocation: $*" >&2
  exit 64
fi

path="$2"
shift 2
jq_filter=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --paginate) shift ;;
    --jq) jq_filter="$2"; shift 2 ;;
    *) echo "fake gh: unsupported flag: $1" >&2; exit 64 ;;
  esac
done

case "$path" in
  *"/issues?"*) key=open-issues ;;
  *"/actions/workflows/"*"/runs?"*) key=runs ;;
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
    open-issues) default='[]' ;;
    runs) default='{"workflow_runs":[]}' ;;
    *) default='' ;;
  esac
  if [ -n "$jq_filter" ]; then
    printf '%s' "$default" | jq -r "$jq_filter"
  else
    printf '%s\n' "$default"
  fi
fi
FAKE_GH
chmod +x "$fake_bin/gh"
export PATH="$fake_bin:$PATH"

# Common env every case starts from; each case overrides what it needs.
base_env() {
  export GH_TOKEN=test-token
  export REPO=example/consumer
  export SERVER_URL=https://github.com
  export RUN_ID=2002
  export CANARY_STATUS=failure
  export WORKFLOW_FILE=dispatch-canary.yml
  export WORKFLOW_NAME="Dispatch Canary"
  export MAINTAINER=maintainer-login
}

run_case() {
  local name="$1"
  local case_dir="$test_root/$name"
  mkdir -p "$case_dir"
  export FAKE_GH_DIR="$case_dir"
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
  echo "--- calls ---" >&2
  cat "$FAKE_GH_DIR/calls" >&2
  exit 1
}

# --- Case 1: first failure - no open alert issue exists yet. Must create
# exactly one issue, labelled and assigned, with a consecutive count of 1
# (no prior failing run in history). ---
(
  base_env
  case_dir="$test_root/first-failure"
  mkdir -p "$case_dir"
  echo '[]' > "$case_dir/open-issues.json"
  echo '{"workflow_runs":[]}' > "$case_dir/runs.json"
  run_case first-failure
  test "$status" = 0 || fail "first failure should exit 0"
  grep -q 'issue create' "$FAKE_GH_DIR/calls" || fail "expected an issue to be created"
  grep -q -- '--title Dispatch Canary is failing' "$FAKE_GH_DIR/calls" || fail "expected the title to name the canary"
  grep -q -- '--label status:needs-human' "$FAKE_GH_DIR/calls" || fail "expected the status:needs-human label"
  grep -q -- '--assignee maintainer-login' "$FAKE_GH_DIR/calls" || fail "expected the maintainer to be assigned"
  grep -q "https://github.com/example/consumer/actions/runs/2002" "$FAKE_GH_DIR/calls" || fail "expected the failing run URL in the issue body"
  grep -qE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z' "$FAKE_GH_DIR/calls" || fail "expected a UTC timestamp in the issue body"
  grep -q 'Consecutive failures: 1' "$FAKE_GH_DIR/calls" || fail "expected a consecutive-failure count of 1"
  if grep -q 'issue comment' "$FAKE_GH_DIR/calls"; then
    fail "first failure must not comment (nothing to comment on)"
  fi
  if grep -q 'issue close' "$FAKE_GH_DIR/calls"; then
    fail "first failure must not close anything"
  fi
)

# --- Case 2: second failure - an alert issue is already open. Must comment
# on it and NOT create a second issue. Also proves the current run's own id
# is excluded from the history count (a defensive belt-and-braces check,
# since status=completed should already exclude it server-side): the fixture
# includes an entry whose id equals RUN_ID, which must NOT be double-counted
# on top of the one genuine prior failure. ---
(
  base_env
  case_dir="$test_root/second-failure"
  mkdir -p "$case_dir"
  cat > "$case_dir/open-issues.json" <<'JSON'
[{"number":55,"body":"<!-- agent-lcars:canary-alert:v1 -->\nDispatch Canary failed.\n"}]
JSON
  cat > "$case_dir/runs.json" <<'JSON'
{"workflow_runs":[{"id":2002,"conclusion":"failure"},{"id":1001,"conclusion":"failure"},{"id":1000,"conclusion":"success"}]}
JSON
  run_case second-failure
  test "$status" = 0 || fail "second failure should exit 0"
  grep -q 'issue comment 55' "$FAKE_GH_DIR/calls" || fail "expected a comment on the existing alert issue #55"
  grep -q 'Consecutive failures: 2' "$FAKE_GH_DIR/calls" || fail "expected a consecutive-failure count of 2 (this run + one prior failure, current run excluded, oldest success stops the streak)"
  if grep -q 'issue create' "$FAKE_GH_DIR/calls"; then
    fail "second failure must NOT create a second issue"
  fi
)

# --- Case 3: success with an open alert issue - must close it with a
# recovery comment, and must not bother querying run history (irrelevant on
# the success path). ---
(
  base_env
  export CANARY_STATUS=success
  case_dir="$test_root/success-closes"
  mkdir -p "$case_dir"
  cat > "$case_dir/open-issues.json" <<'JSON'
[{"number":77,"body":"<!-- agent-lcars:canary-alert:v1 -->\nDispatch Canary failed.\n"}]
JSON
  run_case success-closes
  test "$status" = 0 || fail "success with an open alert issue should exit 0"
  grep -q 'issue close 77' "$FAKE_GH_DIR/calls" || fail "expected the alert issue to be closed"
  grep -q -- '--reason completed' "$FAKE_GH_DIR/calls" || fail "expected a completed close reason"
  grep -q 'recovered' "$FAKE_GH_DIR/calls" || fail "expected a recovery comment"
  if grep -q '/actions/workflows/' "$FAKE_GH_DIR/calls"; then
    fail "success path must not query run history - the count is irrelevant here"
  fi
  if grep -q 'issue create' "$FAKE_GH_DIR/calls"; then
    fail "success must never create an issue"
  fi
)

# --- Case 4: success with no open alert issue - must do NOTHING beyond the
# read-only lookup that discovers there is nothing to do. No comment, no
# close, no create - and no run-history query either. ---
(
  base_env
  export CANARY_STATUS=success
  case_dir="$test_root/success-noop"
  mkdir -p "$case_dir"
  echo '[]' > "$case_dir/open-issues.json"
  run_case success-noop
  test "$status" = 0 || fail "success with no open alert issue should exit 0"
  grep -q 'issues?state=open' "$FAKE_GH_DIR/calls" || fail "expected the read-only lookup for an open alert issue"
  if grep -qE 'issue (close|comment|create)' "$FAKE_GH_DIR/calls"; then
    fail "success with nothing tracked must perform NO issue mutation"
  fi
  if grep -q '/actions/workflows/' "$FAKE_GH_DIR/calls"; then
    fail "success path must not query run history"
  fi
)

# --- Case 5: the alert issue lookup itself fails during a failing canary -
# must fail red and loudly, and must NOT attempt any mutation on top of an
# inconclusive read (no half-done create/comment). This is the script's own
# half of "an alerting failure must never mask the canary's result" - the
# other half (a failed step here still can't flip the JOB's conclusion) is
# action.yml's continue-on-error: true on this same step, which is not
# exercised by a script-level test. ---
(
  base_env
  case_dir="$test_root/lookup-fails"
  mkdir -p "$case_dir"
  : > "$case_dir/open-issues.fail"
  run_case lookup-fails
  test "$status" = 1 || fail "a failed alert-issue lookup must exit non-zero"
  case "$output" in
    *"::error::"*"Alert issue lookup"*) ;;
    *) fail "expected an ::error:: naming the failed alert issue lookup" ;;
  esac
  if grep -qE 'issue (close|comment|create)' "$FAKE_GH_DIR/calls"; then
    fail "must not attempt any issue mutation after a failed lookup"
  fi
)

# --- Case 6: the alert issue lookup succeeds (an issue is already open) but
# the run-history lookup for the consecutive count fails - must fail red
# before commenting, not comment with a wrong/missing count. ---
(
  base_env
  case_dir="$test_root/history-lookup-fails"
  mkdir -p "$case_dir"
  cat > "$case_dir/open-issues.json" <<'JSON'
[{"number":55,"body":"<!-- agent-lcars:canary-alert:v1 -->"}]
JSON
  : > "$case_dir/runs.fail"
  run_case history-lookup-fails
  test "$status" = 1 || fail "a failed run-history lookup must exit non-zero"
  case "$output" in
    *"::error::"*"Consecutive-failure count lookup"*) ;;
    *) fail "expected an ::error:: naming the failed run-history lookup" ;;
  esac
  if grep -q 'issue comment' "$FAKE_GH_DIR/calls"; then
    fail "must not comment with an uncomputed consecutive count"
  fi
)

# --- Case 7: issue creation itself fails (e.g. a transient API hiccup) -
# must fail red and log which call failed. ---
(
  base_env
  case_dir="$test_root/create-fails"
  mkdir -p "$case_dir"
  echo '[]' > "$case_dir/open-issues.json"
  echo '{"workflow_runs":[]}' > "$case_dir/runs.json"
  : > "$case_dir/create.fail"
  run_case create-fails
  test "$status" = 1 || fail "a failed issue creation must exit non-zero"
  case "$output" in
    *"::error::"*"Failed to create alert issue"*) ;;
    *) fail "expected an ::error:: naming the failed creation" ;;
  esac
)

# --- Case 8: recovery close/comment fails on the success path - must fail
# red rather than silently reporting a recovery that didn't land. ---
(
  base_env
  export CANARY_STATUS=success
  case_dir="$test_root/close-fails"
  mkdir -p "$case_dir"
  cat > "$case_dir/open-issues.json" <<'JSON'
[{"number":77,"body":"<!-- agent-lcars:canary-alert:v1 -->"}]
JSON
  : > "$case_dir/close.fail"
  run_case close-fails
  test "$status" = 1 || fail "a failed recovery close must exit non-zero"
  case "$output" in
    *"::error::"*"Failed to post recovery comment and close"*) ;;
    *) fail "expected an ::error:: naming the failed close" ;;
  esac
)

# --- Case 9: more than one open alert issue exists (should not happen in
# normal operation - dispatch-canary-run's concurrency group serializes
# runs) - must deterministically use the oldest (lowest-numbered) one and
# say so, rather than silently picking whichever the API returned first. ---
(
  base_env
  export CANARY_STATUS=success
  case_dir="$test_root/multiple-open-issues"
  mkdir -p "$case_dir"
  cat > "$case_dir/open-issues.json" <<'JSON'
[{"number":90,"body":"<!-- agent-lcars:canary-alert:v1 -->"},{"number":42,"body":"<!-- agent-lcars:canary-alert:v1 -->"}]
JSON
  run_case multiple-open-issues
  test "$status" = 0 || fail "multiple open alert issues should still resolve and exit 0"
  grep -q 'issue close 42' "$FAKE_GH_DIR/calls" || fail "expected the oldest (lowest-numbered) issue #42 to be closed"
  case "$output" in
    *"::notice::"*"Found 2 open issues"*) ;;
    *) fail "expected a ::notice:: flagging the unexpected duplicate" ;;
  esac
)

echo "canary-alert.test.sh: all cases passed"
