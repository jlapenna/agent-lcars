#!/usr/bin/env bash
# Each case below runs in its own `( ... )` subshell so exported overrides
# (MODE, EXCLUDE_*) never leak into the next case; shellcheck can't see
# across that isolation, hence the blanket disable below.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/verify-deliverable.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A fake `gh` on PATH: dispatches on the REST path requested and answers
# from JSON fixtures under $FAKE_GH_DIR, or simulates a transient failure
# when a `<key>.fail` marker file is present. Missing fixtures default to
# "nothing found" so each case only has to set up what it cares about.
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != "api" ]; then
  echo "fake gh: unsupported invocation: $*" >&2
  exit 64
fi
path="$2"
case "$path" in
  *"/comments?"*) key=comments ;;
  *"/pulls?"*) key=pulls ;;
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
    pulls | comments) echo "[]" ;;
    issue) echo '{"state":"open","closed_at":null,"labels":[]}' ;;
  esac
fi
FAKE_GH
chmod +x "$fake_bin/gh"
export PATH="$fake_bin:$PATH"

# Common env every case starts from; each case overrides what it needs.
base_env() {
  export GH_TOKEN=test-token
  export AGENT="Test Agent"
  export REPO=example/consumer
  export NUM=42
  export STARTED_AT=2024-01-01T00:00:00Z
  export MODE=implement
  export EXPECTED_COMMENT_LOGIN="agent-lcars[bot]"
  export EXCLUDE_PR_AUTHOR=
  export EXCLUDE_COMMENT_ID=
}

run_case() {
  local name="$1"
  local case_dir="$test_root/$name"
  mkdir -p "$case_dir"
  export FAKE_GH_DIR="$case_dir"
  export GITHUB_ENV="$case_dir/github-env"
  : > "$GITHUB_ENV"
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

# --- Case 1: clause (a) - PR referencing the issue, updated since start ---
(
  base_env
  case_dir="$test_root/pr-passes"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":7,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case pr-passes
  test "$status" = 0 || fail "clause (a) should pass"
  case "$output" in
    *"Deliverable evidence: PR referencing #42"*) ;;
    *) fail "clause (a) message missing expected text" ;;
  esac
)

# --- Case 2: clause (a) excludes a sibling pipeline's PR by author ---
(
  base_env
  export EXCLUDE_PR_AUTHOR="claude[bot]"
  case_dir="$test_root/pr-excluded-author"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":7,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"claude[bot]"}}]
JSON
  run_case pr-excluded-author
  test "$status" = 1 || fail "excluded-author PR must not satisfy clause (a)"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "excluded-author case should fall through to no-deliverable" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "excluded-author case should still be a genuine (not errored) no-deliverable"
)

# --- Case 3: clause (b) - issue closed since start ---
(
  base_env
  case_dir="$test_root/issue-closed"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"closed","closed_at":"2024-01-02T00:00:00Z","labels":[]}
JSON
  run_case issue-closed
  test "$status" = 0 || fail "clause (b) should pass"
  case "$output" in
    *"closed at 2024-01-02T00:00:00Z"*) ;;
    *) fail "clause (b) message missing expected text" ;;
  esac
)

# --- Case 4: clause (c) - status:needs-human label present ---
(
  base_env
  case_dir="$test_root/needs-human-label"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"open","closed_at":null,"labels":[{"name":"status:needs-human"}]}
JSON
  run_case needs-human-label
  test "$status" = 0 || fail "clause (c) should pass"
  case "$output" in
    *"status:needs-human label applied"*) ;;
    *) fail "clause (c) message missing expected text" ;;
  esac
)

# --- Case 5: clause (d) - reply-mode comment, pickup comment excluded ---
(
  base_env
  export MODE=reply
  export EXCLUDE_COMMENT_ID=555
  case_dir="$test_root/reply-comment"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":555,"user":{"login":"agent-lcars[bot]"}},{"id":556,"user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case reply-comment
  test "$status" = 0 || fail "clause (d) should pass on reply mode"
  case "$output" in
    *"agent-lcars[bot] posted a comment"*) ;;
    *) fail "clause (d) message missing expected text" ;;
  esac
)

# --- Case 6: clause (d) is NOT evaluated outside reply mode, even with a
# qualifying comment present - the whole run must still fail ---
(
  base_env
  export MODE=implement
  case_dir="$test_root/comment-ignored-outside-reply"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":556,"user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case comment-ignored-outside-reply
  test "$status" = 1 || fail "a bare comment must not satisfy the gate outside reply mode"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message" ;;
  esac
  case "$output" in
    *"no qualifying comment posted"*) fail "reply-only clause should not be mentioned outside reply mode" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "expected NO_DELIVERABLE=1 to be recorded"
)

# --- Case 7: all four clauses empty (reply mode) - genuine no-deliverable ---
(
  base_env
  export MODE=reply
  run_case all-empty-reply
  test "$status" = 1 || fail "all-empty case must fail"
  case "$output" in
    *"no deliverable"*"no qualifying comment posted"*) ;;
    *) fail "all-empty reply-mode message should name the missing comment clause too" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "genuine no-deliverable must set NO_DELIVERABLE=1"
)

# --- Case 8: a FAILED lookup is distinguishable from "no deliverable found" ---
(
  base_env
  case_dir="$test_root/pr-lookup-fails"
  mkdir -p "$case_dir"
  : > "$case_dir/pulls.fail"
  run_case pr-lookup-fails
  test "$status" = 1 || fail "a failed lookup must fail the step"
  case "$output" in
    *"FAILED lookup, distinct from 'no deliverable found'"*"PR list lookup"*) ;;
    *) fail "expected a distinct FAILED-lookup message naming the PR list lookup" ;;
  esac
  case "$output" in
    *"produced no deliverable"*) fail "a failed lookup must not be reported as a confirmed empty result" ;;
  esac
  if grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" 2>/dev/null; then
    fail "an inconclusive (errored) check must not set NO_DELIVERABLE=1"
  fi
)

# --- Case 9: evidence found later still passes even if an earlier clause's
# lookup itself failed ---
(
  base_env
  case_dir="$test_root/error-then-found"
  mkdir -p "$case_dir"
  : > "$case_dir/pulls.fail"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"closed","closed_at":"2024-01-02T00:00:00Z","labels":[]}
JSON
  run_case error-then-found
  test "$status" = 0 || fail "found evidence should win even after an earlier clause's lookup failed"
  case "$output" in
    *"closed at 2024-01-02T00:00:00Z"*) ;;
    *) fail "expected the issue-closed evidence message" ;;
  esac
)

echo "verify-deliverable.test.sh: all cases passed"
