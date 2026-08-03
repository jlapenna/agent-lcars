#!/usr/bin/env bash
# Each case below runs in its own `( ... )` subshell so exported overrides
# never leak into the next case; shellcheck can't see across that
# isolation, hence the blanket disable below.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/report-failure.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A fake `gh` on PATH: dispatches on the subcommand/REST path requested and
# answers from JSON fixtures under $FAKE_GH_DIR, or simulates a failure when
# a `<key>.fail` marker file is present. Every call is also logged so a case
# can assert on what was actually invoked.
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

if [ "$1" != "api" ]; then
  echo "fake gh: unsupported invocation: $*" >&2
  exit 64
fi
path="$2"
case "$path" in
  */labels) key=labels ;;
  */assignees) key=assignees ;;
  */issues/*) key=issue ;;
  *)
    echo "fake gh: unrecognized api path: $path" >&2
    exit 64
    ;;
esac

if [ -f "$FAKE_GH_DIR/$key.fail" ]; then
  echo "fake gh: simulated transient failure for $key" >&2
  exit 1
fi

if [ "$key" = "issue" ]; then
  if [ -f "$FAKE_GH_DIR/issue.json" ]; then
    cat "$FAKE_GH_DIR/issue.json"
  else
    echo '{"labels":[],"assignees":[]}'
  fi
fi
FAKE_GH
chmod +x "$fake_bin/gh"
export PATH="$fake_bin:$PATH"

# Common env every case starts from; each case overrides what it needs.
base_env() {
  export GH_TOKEN=test-token
  export AGENT="Test Agent"
  export REPO=example/consumer
  export SERVER_URL=https://github.com
  export RUN_ID=30749363701
  export ISSUE_NUM=42
  export JOB_STATUS=failure
  export MAINTAINER=maintainer-login
  export MESSAGE_PREFIX=""
  export REASON=""
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
  exit 1
}

# --- Case 1: happy path - comment, label, and assignee all succeed on the
# first try. No verification reads, no notices, exit 0. ---
(
  base_env
  run_case happy-path
  test "$status" = 0 || fail "happy path should exit 0"
  case "$output" in
    *"::notice::"*) fail "happy path should not need a verify-then-decide notice" ;;
  esac
  case "$output" in
    *"::error::"*) fail "happy path should not log an error" ;;
  esac
  grep -q 'issue comment 42' "$FAKE_GH_DIR/calls" || fail "expected the failure comment to be posted"
  if grep -q '/issues/42$' "$FAKE_GH_DIR/calls"; then
    fail "happy path should never need the verification re-read"
  fi
)

# --- Case 2: label add reports a gh api failure (response-parse hiccup) but
# the label actually landed - verify-then-decide should notice and exit 0. ---
(
  base_env
  case_dir="$test_root/label-hiccup-landed"
  mkdir -p "$case_dir"
  : > "$case_dir/labels.fail"
  cat > "$case_dir/issue.json" <<'JSON'
{"labels":[{"name":"status:needs-human"}],"assignees":[]}
JSON
  run_case label-hiccup-landed
  test "$status" = 0 || fail "label hiccup with landed mutation should still exit 0"
  case "$output" in
    *"::notice::"*"status:needs-human"*"#346"*) ;;
    *) fail "expected a ::notice:: naming status:needs-human and #346" ;;
  esac
  case "$output" in
    *"::error::"*) fail "a landed mutation must not log an error" ;;
  esac
)

# --- Case 3: label add fails and verification confirms the label is
# genuinely absent - must still fail red. ---
(
  base_env
  case_dir="$test_root/label-hiccup-absent"
  mkdir -p "$case_dir"
  : > "$case_dir/labels.fail"
  cat > "$case_dir/issue.json" <<'JSON'
{"labels":[],"assignees":[]}
JSON
  run_case label-hiccup-absent
  test "$status" = 1 || fail "a genuinely absent label must fail the step"
  case "$output" in
    *"::error::"*"status:needs-human"*"absent"*) ;;
    *) fail "expected an ::error:: naming the absent label" ;;
  esac
  if grep -q '/issues/42/assignees' "$FAKE_GH_DIR/calls"; then
    fail "must not attempt the assignee mutation after a confirmed label failure"
  fi
)

# --- Case 4: assignee add reports a gh api failure but the assignment
# actually landed - notice and exit 0. ---
(
  base_env
  case_dir="$test_root/assignee-hiccup-landed"
  mkdir -p "$case_dir"
  : > "$case_dir/assignees.fail"
  cat > "$case_dir/issue.json" <<'JSON'
{"labels":[{"name":"status:needs-human"}],"assignees":[{"login":"maintainer-login"}]}
JSON
  run_case assignee-hiccup-landed
  test "$status" = 0 || fail "assignee hiccup with landed mutation should still exit 0"
  case "$output" in
    *"::notice::"*"maintainer-login"*"#346"*) ;;
    *) fail "expected a ::notice:: naming the maintainer and #346" ;;
  esac
)

# --- Case 5: assignee add fails and verification confirms the assignment is
# genuinely absent - must fail red. ---
(
  base_env
  case_dir="$test_root/assignee-hiccup-absent"
  mkdir -p "$case_dir"
  : > "$case_dir/assignees.fail"
  cat > "$case_dir/issue.json" <<'JSON'
{"labels":[{"name":"status:needs-human"}],"assignees":[]}
JSON
  run_case assignee-hiccup-absent
  test "$status" = 1 || fail "a genuinely absent assignment must fail the step"
  case "$output" in
    *"::error::"*"maintainer-login"*"absent"*) ;;
    *) fail "expected an ::error:: naming the absent assignment" ;;
  esac
)

# --- Case 6: label add fails AND the verification re-read itself fails -
# inconclusive, so it must still fail red (not be treated as landed). ---
(
  base_env
  case_dir="$test_root/label-verify-inconclusive"
  mkdir -p "$case_dir"
  : > "$case_dir/labels.fail"
  : > "$case_dir/issue.fail"
  run_case label-verify-inconclusive
  test "$status" = 1 || fail "an inconclusive verification read must fail the step"
  case "$output" in
    *"::error::"*"verification re-read also failed"*) ;;
    *) fail "expected an ::error:: distinguishing an inconclusive re-read" ;;
  esac
)

# --- Case 7: the failure comment itself fails - left strict, always fails
# red regardless of the (unreached) label/assignee mutations. ---
(
  base_env
  case_dir="$test_root/comment-fails"
  mkdir -p "$case_dir"
  : > "$case_dir/comment.fail"
  run_case comment-fails
  test "$status" = 1 || fail "a failed comment post must fail the step"
  if grep -q '/issues/42/labels' "$FAKE_GH_DIR/calls"; then
    fail "must not attempt the label mutation after a failed comment"
  fi
)

echo "report-failure.test.sh: all cases passed"
