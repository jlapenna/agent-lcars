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
shift 2
# Understand the flags the real script uses, so a test exercises the real
# jq filter rather than a stub that quietly ignores it. --paginate is a
# no-op here (fixtures are a single page) but must be accepted, since the
# script passes it and an unrecognised flag would otherwise pass silently.
jq_filter=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --paginate) shift ;;
    --jq) jq_filter="$2"; shift 2 ;;
    *) echo "fake gh: unsupported flag: $1" >&2; exit 64 ;;
  esac
done
case "$path" in
  *"/reviews?"*) key=reviews ;;
  *"/comments?"*) key=comments ;;
  *"/pulls?"*) key=pulls ;;
  *"/timeline"*) key=timeline ;;
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
    issue) default='{"state":"open","closed_at":null,"labels":[]}' ;;
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
  export AGENT="Test Agent"
  export REPO=example/consumer
  export NUM=42
  export STARTED_AT=2024-01-01T00:00:00Z
  export MODE=implement
  export RUNBOOK=
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

# --- Case 2: clause (a) excludes a sibling pipeline's PR by author on an
# implement dispatch (mode defaults to implement in base_env) ---
(
  base_env
  export EXCLUDE_PR_AUTHOR="claude[bot]"
  case_dir="$test_root/pr-excluded-author-implement"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":7,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"claude[bot]"}}]
JSON
  run_case pr-excluded-author-implement
  test "$status" = 1 || fail "excluded-author PR must not satisfy clause (a) on an implement dispatch"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "excluded-author case should fall through to no-deliverable" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "excluded-author case should still be a genuine (not errored) no-deliverable"
)

# --- Case 2a2: clause (a)'s author exclusion is comma-separated - every
# listed sibling pipeline login is excluded, an unlisted author still
# counts ---
(
  base_env
  export EXCLUDE_PR_AUTHOR="claude[bot],agent-lcars[bot]"
  case_dir="$test_root/pr-excluded-author-list"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":7,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"claude[bot]"}},{"number":8,"title":"Also #42","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case pr-excluded-author-list
  test "$status" = 1 || fail "every login in a comma-separated exclusion list must be excluded"
)
(
  base_env
  export EXCLUDE_PR_AUTHOR="claude[bot],agent-lcars[bot]"
  case_dir="$test_root/pr-unlisted-author-passes"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":9,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"codex[bot]"}}]
JSON
  run_case pr-unlisted-author-passes
  test "$status" = 0 || fail "an author absent from the exclusion list must still satisfy clause (a)"
)

# --- Case 2b: clause (a) does NOT exclude by author on a reply dispatch -
# the anchor is explicit, so an update to a PR referencing it is valid
# evidence regardless of author (e.g. a @claude reply continuing a PR codex
# originally opened must not be discarded as "not my PR") ---
(
  base_env
  export MODE=reply
  export EXCLUDE_PR_AUTHOR="claude[bot]"
  case_dir="$test_root/pr-excluded-author-reply-bypass"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":7,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"claude[bot]"}}]
JSON
  run_case pr-excluded-author-reply-bypass
  test "$status" = 0 || fail "an excluded-author PR must still satisfy clause (a) on a reply dispatch"
  case "$output" in
    *"Deliverable evidence: PR referencing #42"*) ;;
    *) fail "reply-mode bypass message missing expected text" ;;
  esac
)

# --- Case 2c: clause (a) also matches when #NUM IS the PR's own number -
# an implement dispatch whose anchor is a pull request (agent:* takeover,
# #567), where the pushed-to PR never mentions its own number in its own
# title/body ---
(
  base_env
  case_dir="$test_root/pr-self-referencing-anchor"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":42,"title":"Fix widget","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case pr-self-referencing-anchor
  test "$status" = 0 || fail "clause (a) should pass when the PR IS #NUM"
  case "$output" in
    *"Deliverable evidence: PR referencing #42"*) ;;
    *) fail "self-referencing-anchor message missing expected text" ;;
  esac
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

# --- Case 4: clause (c) - status:needs-human label present AND applied
# during this run (timeline `labeled` event at/after STARTED_AT) ---
(
  base_env
  case_dir="$test_root/needs-human-label"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"open","closed_at":null,"labels":[{"name":"status:needs-human"}]}
JSON
  cat > "$case_dir/timeline.json" <<'JSON'
[{"event":"labeled","label":{"name":"status:needs-human"},"created_at":"2024-01-02T00:00:00Z"}]
JSON
  run_case needs-human-label
  test "$status" = 0 || fail "clause (c) should pass when the label was applied during this run"
  case "$output" in
    *"status:needs-human label applied on #42 since 2024-01-01T00:00:00Z"*) ;;
    *) fail "clause (c) message missing expected text" ;;
  esac
)

# --- Case 4b: clause (c) - the label is currently present but the
# timeline's `labeled` event predates STARTED_AT (a stale, pre-existing
# park from an earlier run) - must NOT satisfy the gate. Regression test
# for the bug confirmed live on #650: a park from an earlier failed
# generation let a later no-op generation's run report success. ---
(
  base_env
  case_dir="$test_root/needs-human-label-stale"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"open","closed_at":null,"labels":[{"name":"status:needs-human"}]}
JSON
  cat > "$case_dir/timeline.json" <<'JSON'
[{"event":"labeled","label":{"name":"status:needs-human"},"created_at":"2023-12-31T00:00:00Z"}]
JSON
  run_case needs-human-label-stale
  test "$status" = 1 || fail "a stale, pre-existing park must not satisfy clause (c)"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message for a stale park" ;;
  esac
  case "$output" in
    *"status:needs-human label applied"*) fail "a stale park must not be reported as evidence" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "a stale park must still be a genuine (not errored) no-deliverable"
)

# --- Case 4e: clause (c) - the label WAS applied during this run but has
# since been REMOVED (the run became unblocked, or a human unparked it).
# A `labeled` timeline event is permanent, so recency alone would keep
# satisfying the gate forever even though the issue is no longer parked.
# Both halves are required: applied by THIS run, and still parked now. ---
(
  base_env
  case_dir="$test_root/needs-human-label-applied-then-removed"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"open","closed_at":null,"labels":[]}
JSON
  cat > "$case_dir/timeline.json" <<'JSON'
[{"event":"labeled","label":{"name":"status:needs-human"},"created_at":"2024-01-02T00:00:00Z"},
 {"event":"unlabeled","label":{"name":"status:needs-human"},"created_at":"2024-01-02T01:00:00Z"}]
JSON
  run_case needs-human-label-applied-then-removed
  test "$status" = 1 || fail "a park applied then removed must not satisfy clause (c)"
  case "$output" in
    *"status:needs-human label applied"*) fail "a removed park must not be reported as evidence" ;;
    *) ;;
  esac
)

# --- Case 4c: clause (c) - the label is absent entirely (current default
# behaviour, unchanged by the recency fix) ---
(
  base_env
  case_dir="$test_root/needs-human-label-absent"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"open","closed_at":null,"labels":[]}
JSON
  run_case needs-human-label-absent
  test "$status" = 1 || fail "no label at all must not satisfy clause (c)"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message when the label is absent" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "a genuinely absent label must still be a genuine (not errored) no-deliverable"
)

# --- Case 4d: clause (c) - the timeline lookup itself fails; this must be
# reported as an inconclusive error, not silently treated as "no
# deliverable" (this repo already fixed that class of bug once - see the
# header comment's "A FAILED lookup is never silently treated as 'no
# deliverable found'" rule - and it must not regress here). ---
(
  base_env
  case_dir="$test_root/needs-human-timeline-lookup-fails"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"open","closed_at":null,"labels":[{"name":"status:needs-human"}]}
JSON
  : > "$case_dir/timeline.fail"
  run_case needs-human-timeline-lookup-fails
  test "$status" = 1 || fail "a failed timeline lookup must fail the step"
  case "$output" in
    *"FAILED lookup, distinct from 'no deliverable found'"*"Issue timeline lookup"*) ;;
    *) fail "expected a distinct FAILED-lookup message naming the issue timeline lookup" ;;
  esac
  case "$output" in
    *"produced no deliverable"*) fail "a failed timeline lookup must not be reported as a confirmed empty result" ;;
  esac
  if grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" 2>/dev/null; then
    fail "an inconclusive (errored) timeline lookup must not set NO_DELIVERABLE=1"
  fi
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

# --- Case 5b: clause (d) also fires on a runbook dispatch (implement mode
# but RUNBOOK non-empty) - a runbook's sanctioned deliverable can be a
# summary comment ---
(
  base_env
  export MODE=implement
  export RUNBOOK=unsticking-stuck-prs
  case_dir="$test_root/runbook-comment"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":600,"user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case runbook-comment
  test "$status" = 0 || fail "clause (d) should pass on a runbook dispatch"
  case "$output" in
    *"agent-lcars[bot] posted a comment"*) ;;
    *) fail "runbook clause (d) message missing expected text" ;;
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

# --- Case 6b: clause (e) - review-mode PR review evidence ---
(
  base_env
  export MODE=review
  case_dir="$test_root/review-comment"
  mkdir -p "$case_dir"
  cat > "$case_dir/reviews.json" <<'JSON'
[{"user":{"login":"agent-lcars[bot]"},"submitted_at":"2024-01-02T00:00:00Z"}]
JSON
  run_case review-comment
  test "$status" = 0 || fail "clause (e) should pass on review mode"
  case "$output" in
    *"agent-lcars[bot] submitted a pull request review"*) ;;
    *) fail "clause (e) message missing expected text" ;;
  esac
)

# --- Case 6c: clause (e) is NOT evaluated outside review mode, even with a
# qualifying review present - the whole run must still fail ---
(
  base_env
  export MODE=implement
  case_dir="$test_root/review-ignored-outside-review"
  mkdir -p "$case_dir"
  cat > "$case_dir/reviews.json" <<'JSON'
[{"user":{"login":"agent-lcars[bot]"},"submitted_at":"2024-01-02T00:00:00Z"}]
JSON
  run_case review-ignored-outside-review
  test "$status" = 1 || fail "a bare review must not satisfy the gate outside review mode"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message" ;;
  esac
  case "$output" in
    *"no qualifying pull request review submitted"*) fail "review-only clause should not be mentioned outside review mode" ;;
  esac
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

# --- Case 7b: all clauses empty (review mode) - genuine no-deliverable ---
(
  base_env
  export MODE=review
  run_case all-empty-review
  test "$status" = 1 || fail "all-empty review case must fail"
  case "$output" in
    *"no deliverable"*"no qualifying pull request review submitted"*) ;;
    *) fail "all-empty review-mode message should name the missing review clause too" ;;
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

# --- Case 10: clause (0) - an exact attempt-claim marker on a PR passes,
# WITHOUT going through clause (a)'s inference at all. The PR is built so
# clause (a) would reject it on every one of its own grounds (updated
# BEFORE STARTED_AT, author on the exclusion list, no "#42" reference and
# not #NUM itself) - if this still passes, only clause (0) could have found
# it ---
(
  base_env
  export ATTEMPT_ID="g1:test-intent"
  export EXCLUDE_PR_AUTHOR="agent-lcars[bot]"
  case_dir="$test_root/claim-marker-on-pr"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":99,"title":"Unrelated change","body":"<!-- attempt-claim:g1:test-intent -->","updated_at":"2023-12-01T00:00:00Z","user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case claim-marker-on-pr
  test "$status" = 0 || fail "an exact attempt-claim marker on a PR should pass"
  case "$output" in
    *"::notice::"*"verified via EXACT attempt-claim marker"*) ;;
    *) fail "expected the EXACT-path notice" ;;
  esac
  case "$output" in
    *"Deliverable evidence: PR carrying this run's attempt-claim marker (g1:test-intent)"*) ;;
    *) fail "clause (0) PR message missing expected text" ;;
  esac
  case "$output" in
    *"PR referencing #42"*) fail "should not have gone through clause (a)'s inference message" ;;
  esac
)

# --- Case 11: clause (0) - an exact attempt-claim marker on a comment
# passes even in implement mode, where clause (d)'s bare-comment inference
# is never evaluated at all ---
(
  base_env
  export ATTEMPT_ID="g1:test-intent"
  export MODE=implement
  case_dir="$test_root/claim-marker-on-comment"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":701,"user":{"login":"someone-else"},"body":"<!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case claim-marker-on-comment
  test "$status" = 0 || fail "an exact attempt-claim marker on a comment should pass, even in implement mode"
  case "$output" in
    *"::notice::"*"verified via EXACT attempt-claim marker"*) ;;
    *) fail "expected the EXACT-path notice" ;;
  esac
  case "$output" in
    *"Deliverable evidence: comment carrying this run's attempt-claim marker (g1:test-intent)"*) ;;
    *) fail "clause (0) comment message missing expected text" ;;
  esac
)

# --- Case 12: clause (0) - an exact attempt-claim marker on a PR review
# passes in review mode, without needing submitted_at >= STARTED_AT the way
# clause (e)'s inference does ---
(
  base_env
  export ATTEMPT_ID="g1:test-intent"
  export MODE=review
  case_dir="$test_root/claim-marker-on-review"
  mkdir -p "$case_dir"
  cat > "$case_dir/reviews.json" <<'JSON'
[{"user":{"login":"someone-else"},"submitted_at":"2020-01-01T00:00:00Z","body":"<!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case claim-marker-on-review
  test "$status" = 0 || fail "an exact attempt-claim marker on a review should pass"
  case "$output" in
    *"::notice::"*"verified via EXACT attempt-claim marker"*) ;;
    *) fail "expected the EXACT-path notice" ;;
  esac
  case "$output" in
    *"Deliverable evidence: pull request review carrying this run's attempt-claim marker (g1:test-intent)"*) ;;
    *) fail "clause (0) review message missing expected text" ;;
  esac
)

# --- Case 13: a claim marker naming a DIFFERENT attempt must NOT satisfy
# this run - that is the whole point of an exact claim. A PR and a comment
# both carry a foreign attempt's marker; with no other evidence, the run
# must still fail as a genuine no-deliverable ---
(
  base_env
  export ATTEMPT_ID="g1:test-intent"
  case_dir="$test_root/claim-marker-wrong-attempt"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":99,"title":"Unrelated change","body":"<!-- attempt-claim:g9:someone-elses-intent -->","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]"}}]
JSON
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":701,"user":{"login":"someone-else"},"body":"<!-- attempt-claim:g9:someone-elses-intent -->"}]
JSON
  run_case claim-marker-wrong-attempt
  test "$status" = 1 || fail "a marker naming a different attempt must not satisfy this run"
  case "$output" in
    *"verified via EXACT attempt-claim marker"*) fail "a foreign attempt's marker must not be reported as this run's exact evidence" ;;
  esac
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "a foreign marker with no other evidence must still be a genuine (not errored) no-deliverable"
)

# --- Case 14: ATTEMPT_ID is set but no artifact carries a claim marker -
# clause (0) no-ops and the run still passes via the existing inference
# clause (a), exactly as it did before clause (0) existed ---
(
  base_env
  export ATTEMPT_ID="g1:test-intent"
  case_dir="$test_root/attempt-id-set-inference-still-works"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":7,"title":"Fix widget (#42)","body":"","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]"}}]
JSON
  run_case attempt-id-set-inference-still-works
  test "$status" = 0 || fail "inference should still pass when ATTEMPT_ID is set but unclaimed"
  case "$output" in
    *"::notice::"*"verified via INFERENCE"*) ;;
    *) fail "expected the INFERENCE-path notice" ;;
  esac
  case "$output" in
    *"Deliverable evidence: PR referencing #42"*) ;;
    *) fail "expected clause (a)'s own evidence message" ;;
  esac
)

# --- Case 15: ATTEMPT_ID is set, no claim marker anywhere, and no inference
# evidence either - genuine no-deliverable, same as the no-ATTEMPT_ID case ---
(
  base_env
  export ATTEMPT_ID="g1:test-intent"
  run_case attempt-id-set-neither-found
  test "$status" = 1 || fail "neither exact nor inferred evidence must still fail"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "genuine no-deliverable must set NO_DELIVERABLE=1 even with ATTEMPT_ID set"
)

# --- Case 16: in implement mode a transient comment-lookup failure must be
# reported as inconclusive, NOT as a confirmed absence. Clause (d) only runs
# for reply mode or a runbook dispatch, so nothing else re-queries comments
# here -- letting clause 0's failure fall through silently would turn "we
# could not tell" into NO_DELIVERABLE=1 and blame the agent for a network
# blip. ---
(
  base_env
  export ATTEMPT_ID="g1:test-intent"
  export MODE=implement
  case_dir="$test_root/attempt-claim-comment-lookup-failure"
  mkdir -p "$case_dir"
  : > "$case_dir/comments.fail"
  run_case attempt-claim-comment-lookup-failure
  test "$status" = 1 || fail "a failed comment lookup must not pass"
  case "$output" in
    *"FAILED lookup"*) ;;
    *) fail "expected the failed-lookup message, not a genuine-absence one" ;;
  esac
  if grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" 2>/dev/null; then
    fail "an inconclusive lookup must NOT be recorded as a confirmed missing deliverable"
  fi
)

# --- Case 17: the same failure in reply mode falls through as designed,
# because clause (d) does repeat the lookup and owns the distinction. ---
(
  base_env
  export ATTEMPT_ID="g1:test-intent"
  export MODE=reply
  case_dir="$test_root/attempt-claim-comment-failure-reply-mode"
  mkdir -p "$case_dir"
  : > "$case_dir/comments.fail"
  run_case attempt-claim-comment-failure-reply-mode
  test "$status" = 1 || fail "a failed comment lookup must not pass in reply mode either"
  case "$output" in
    *"FAILED lookup"*) ;;
    *) fail "clause (d) should have recorded the failed lookup" ;;
  esac
)

echo "verify-deliverable.test.sh: all cases passed"
