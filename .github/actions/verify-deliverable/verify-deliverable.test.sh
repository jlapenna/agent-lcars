#!/usr/bin/env bash
# Each case below runs in its own `( ... )` subshell so exported overrides
# (MODE, ATTEMPT_ID) never leak into the next case; shellcheck can't see
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
# Fixture kinds beyond pulls/comments/reviews (timeline, issue) are kept
# here even though the exact-marker-only script no longer reads them - the
# negative cases below build fixtures shaped like what the retired
# inference clauses used to accept, to prove they no longer satisfy the
# gate, and a stray unread fixture is harmless.
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

# Common env every case starts from. The retired legacy inference inputs
# (STARTED_AT, EXPECTED_COMMENT_LOGIN, RUNBOOK, EXCLUDE_PR_AUTHOR,
# EXCLUDE_COMMENT_ID) are unset so no case accidentally depends on them;
# the stray-legacy-env case below exports them deliberately to prove the
# script ignores them entirely.
base_env() {
  export GH_TOKEN=test-token
  export AGENT="Test Agent"
  export REPO=example/consumer
  export NUM=42
  export MODE=implement
  export ATTEMPT_ID="g1:test-intent"
  unset STARTED_AT EXPECTED_COMMENT_LOGIN RUNBOOK EXCLUDE_PR_AUTHOR EXCLUDE_COMMENT_ID
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

# ============================================================================
# Positive cases: an exact attempt-claim marker on a PR, comment, or review.
# ============================================================================

# --- Case 1: an exact attempt-claim marker on a PR passes ---
(
  base_env
  case_dir="$test_root/claim-marker-on-pr"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":99,"title":"Unrelated change","body":"<!-- attempt-claim:g1:test-intent -->","updated_at":"2023-12-01T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case claim-marker-on-pr
  test "$status" = 0 || fail "an exact attempt-claim marker on a PR should pass"
  case "$output" in
    *"::notice::"*"verified via exact attempt-claim marker"*) ;;
    *) fail "expected the exact-marker notice" ;;
  esac
  case "$output" in
    *"Deliverable evidence: PR carrying this run's attempt-claim marker (g1:test-intent)"*) ;;
    *) fail "PR message missing expected text" ;;
  esac
  test ! -s "$GITHUB_OUTPUT" || fail "the verifier must publish no step outputs (outcome-kind/-reference were retired 2026-08-17; nothing maps them)"
)

# A duplicated exact marker still proves that at least one PR exists; the
# gate passes on the evidence alone.
(
  base_env
  case_dir="$test_root/claim-marker-on-two-prs"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":99,"title":"One","body":"<!-- attempt-claim:g1:test-intent -->","updated_at":"2023-12-01T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}},{"number":100,"title":"Two","body":"<!-- attempt-claim:g1:test-intent -->","updated_at":"2023-12-01T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case claim-marker-on-two-prs
  test "$status" = 0 || fail "duplicate exact PR markers still prove a PR deliverable"
  test ! -s "$GITHUB_OUTPUT" || fail "the verifier must publish no step outputs (outcome-kind/-reference were retired 2026-08-17; nothing maps them)"
)

# --- #1223: a HUMAN-authored artifact carrying the marker must NOT count ---
# The marker was treated as unforgeable identity, but it is a plain string
# derivable from public issue state and printed in logs, comments, and docs.
# A human PR that merely QUOTED a live marker while documenting this
# mechanism satisfied that run's gate and marked it success with nothing
# produced. Same shape as #711, which clause (a) already had to close.
(
  base_env
  case_dir="$test_root/claim-marker-quoted-by-human-pr"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":1222,"title":"fix: stop the wrapper stamping takeover comments","body":"Quoting the marker to explain the bug:\n\n<!-- attempt-claim:g1:test-intent -->\n","updated_at":"2023-12-01T00:00:00Z","user":{"login":"jlapenna","type":"User"}}]
JSON
  run_case claim-marker-quoted-by-human-pr
  test "$status" != 0 || fail "a human PR quoting the marker must not satisfy the gate"
  case "$output" in
    *"produced no deliverable"*) ;;
    *) fail "expected the no-deliverable error for a human-quoted marker" ;;
  esac
)

(
  base_env
  case_dir="$test_root/claim-marker-quoted-by-human-comment"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":901,"user":{"login":"jlapenna","type":"User"},"body":"For the record this run's marker was <!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case claim-marker-quoted-by-human-comment
  test "$status" != 0 || fail "a human comment quoting the marker must not satisfy the gate"
)

# A human-quoted marker must not rescue a run even when a real bot artifact
# exists elsewhere for a DIFFERENT attempt - the gate must key on this run's
# own bot-authored evidence, nothing else.
(
  base_env
  case_dir="$test_root/claim-marker-human-plus-other-attempt"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":1222,"title":"docs","body":"<!-- attempt-claim:g1:test-intent -->","updated_at":"2023-12-01T00:00:00Z","user":{"login":"jlapenna","type":"User"}},{"number":98,"title":"other run","body":"<!-- attempt-claim:g9:someone-elses-intent -->","updated_at":"2023-12-01T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case claim-marker-human-plus-other-attempt
  test "$status" != 0 || fail "a human-quoted marker plus another attempt's bot PR must not pass"
)

# --- Case 2: an exact attempt-claim marker on a comment passes, in implement
# mode, from ANY BOT commenter - clause 0 is not scoped to one lane's login
# (codex and opencode share agent-lcars[bot]; claude's PRs and comments use
# different identities), only to bot authorship. It is still not the retired
# reply-mode-only bot-login inference. ---
(
  base_env
  export MODE=implement
  case_dir="$test_root/claim-marker-on-comment"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":701,"user":{"login":"someone-else[bot]","type":"Bot"},"body":"<!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case claim-marker-on-comment
  test "$status" = 0 || fail "an exact attempt-claim marker on a comment should pass, even in implement mode"
  case "$output" in
    *"::notice::"*"verified via exact attempt-claim marker"*) ;;
    *) fail "expected the exact-marker notice" ;;
  esac
  case "$output" in
    *"Deliverable evidence: comment carrying this run's attempt-claim marker (g1:test-intent)"*) ;;
    *) fail "comment message missing expected text" ;;
  esac
)

# --- Case 3: a structured no-op is recognized only when the same comment
# carries both its typed result marker and this run's exact claim marker. ---
(
  base_env
  case_dir="$test_root/structured-no-op"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":702,"user":{"login":"agent-lcars[bot]","type":"Bot"},"body":"NO-OP: PR #99 already contains the requested fix and check run 123 is green.\n<!-- agent-result:v1:no-op -->\n<!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case structured-no-op
  test "$status" = 0 || fail "an evidence-backed structured no-op should pass"
  case "$output" in
    *"evidence-backed structured no-op"*) ;;
    *) fail "expected structured no-op evidence" ;;
  esac
  test ! -s "$GITHUB_OUTPUT" || fail "the verifier must publish no step outputs (outcome-kind/-reference were retired 2026-08-17; nothing maps them)"
)

# A comment carrying the typed no-op marker WITHOUT this run's own exact
# claim marker must not be promoted to no-op (or to anything else) - the
# claimed no-op result is only trustworthy when it is also this run's claim.
(
  base_env
  case_dir="$test_root/no-op-marker-without-claim"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":703,"user":{"login":"agent-lcars[bot]","type":"Bot"},"body":"NO-OP: already fixed.\n<!-- agent-result:v1:no-op -->"}]
JSON
  run_case no-op-marker-without-claim
  test "$status" = 1 || fail "a no-op marker without this run's own claim marker must not satisfy the gate"
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
)

# --- Case 3b: a structured park is recognized the same way a structured
# no-op is - agent-protocol.md #4's issue-anchor park path. ---
(
  base_env
  case_dir="$test_root/structured-park"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":704,"user":{"login":"agent-lcars[bot]","type":"Bot"},"body":"PARK: cannot fetch the issue's attached zip; no signed URL is exposed for a /files/ attachment. Resume once a human links the asset directly.\n<!-- agent-result:v1:park -->\n<!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case structured-park
  test "$status" = 0 || fail "an evidence-backed park should pass"
  case "$output" in
    *"evidence-backed park"*) ;;
    *) fail "expected park evidence" ;;
  esac
  test ! -s "$GITHUB_OUTPUT" || fail "the verifier must publish no step outputs (outcome-kind/-reference were retired 2026-08-17; nothing maps them)"
)

# --- Case 4: an exact attempt-claim marker on a PR review passes in review
# mode. ---
(
  base_env
  export MODE=review
  case_dir="$test_root/claim-marker-on-review"
  mkdir -p "$case_dir"
  cat > "$case_dir/reviews.json" <<'JSON'
[{"user":{"login":"someone-else[bot]","type":"Bot"},"submitted_at":"2020-01-01T00:00:00Z","body":"<!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case claim-marker-on-review
  test "$status" = 0 || fail "an exact attempt-claim marker on a review should pass"
  case "$output" in
    *"::notice::"*"verified via exact attempt-claim marker"*) ;;
    *) fail "expected the exact-marker notice" ;;
  esac
  case "$output" in
    *"Deliverable evidence: pull request review carrying this run's attempt-claim marker (g1:test-intent)"*) ;;
    *) fail "review message missing expected text" ;;
  esac
)

# --- Case 5: a review carrying the marker is NOT checked outside review
# mode - the reviews endpoint 404s when #NUM is not a pull request, so this
# must stay gated on MODE=review. ---
(
  base_env
  export MODE=implement
  case_dir="$test_root/review-marker-ignored-outside-review-mode"
  mkdir -p "$case_dir"
  cat > "$case_dir/reviews.json" <<'JSON'
[{"user":{"login":"someone-else[bot]","type":"Bot"},"submitted_at":"2020-01-01T00:00:00Z","body":"<!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case review-marker-ignored-outside-review-mode
  test "$status" = 1 || fail "a review marker must not be checked outside review mode"
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
)

# --- Case 6: a claim marker naming a DIFFERENT attempt must NOT satisfy this
# run - that is the whole point of an exact claim. A PR and a comment both
# carry a foreign attempt's marker; with no other evidence, the run must
# still fail as a genuine no-deliverable ---
(
  base_env
  case_dir="$test_root/claim-marker-wrong-attempt"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":99,"title":"Unrelated change","body":"<!-- attempt-claim:g9:someone-elses-intent -->","updated_at":"2024-01-02T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":701,"user":{"login":"someone-else[bot]","type":"Bot"},"body":"<!-- attempt-claim:g9:someone-elses-intent -->"}]
JSON
  run_case claim-marker-wrong-attempt
  test "$status" = 1 || fail "a marker naming a different attempt must not satisfy this run"
  case "$output" in
    *"verified via exact attempt-claim marker"*) fail "a foreign attempt's marker must not be reported as this run's exact evidence" ;;
  esac
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "a foreign marker with no other evidence must still be a genuine (not errored) no-deliverable"
)

# --- Case 7: evidence found later still passes even if an earlier lookup
# itself failed (the PR lookup errors; the comment lookup then finds the
# marker) ---
(
  base_env
  case_dir="$test_root/error-then-found"
  mkdir -p "$case_dir"
  : > "$case_dir/pulls.fail"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":701,"user":{"login":"someone-else[bot]","type":"Bot"},"body":"<!-- attempt-claim:g1:test-intent -->"}]
JSON
  run_case error-then-found
  test "$status" = 0 || fail "found evidence should win even after an earlier lookup failed"
  case "$output" in
    *"Deliverable evidence: comment carrying this run's attempt-claim marker"*) ;;
    *) fail "expected the comment evidence message" ;;
  esac
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

# --- Case 9: a comment-lookup failure is reported as inconclusive in every
# mode now - unlike the retired script, nothing gates this on MODE/RUNBOOK
# any more, because there is no second clause left to repeat the lookup. ---
(
  base_env
  export MODE=implement
  case_dir="$test_root/comment-lookup-fails-implement"
  mkdir -p "$case_dir"
  : > "$case_dir/comments.fail"
  run_case comment-lookup-fails-implement
  test "$status" = 1 || fail "a failed comment lookup must not pass"
  case "$output" in
    *"FAILED lookup"*"Attempt-claim comment lookup"*) ;;
    *) fail "expected the failed-lookup message naming the comment lookup" ;;
  esac
  if grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" 2>/dev/null; then
    fail "an inconclusive lookup must NOT be recorded as a confirmed missing deliverable"
  fi
)
(
  base_env
  export MODE=reply
  case_dir="$test_root/comment-lookup-fails-reply"
  mkdir -p "$case_dir"
  : > "$case_dir/comments.fail"
  run_case comment-lookup-fails-reply
  test "$status" = 1 || fail "a failed comment lookup must not pass in reply mode either"
  case "$output" in
    *"FAILED lookup"*"Attempt-claim comment lookup"*) ;;
    *) fail "expected the failed-lookup message naming the comment lookup" ;;
  esac
)

# --- Case 10: a review-lookup failure in review mode is reported as
# inconclusive, not a confirmed absence. ---
(
  base_env
  export MODE=review
  case_dir="$test_root/review-lookup-fails"
  mkdir -p "$case_dir"
  : > "$case_dir/reviews.fail"
  run_case review-lookup-fails
  test "$status" = 1 || fail "a failed review lookup must not pass"
  case "$output" in
    *"FAILED lookup"*"PR review lookup"*) ;;
    *) fail "expected the failed-lookup message naming the review lookup" ;;
  esac
  if grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" 2>/dev/null; then
    fail "an inconclusive lookup must NOT be recorded as a confirmed missing deliverable"
  fi
)

# --- Case 11: genuine no-deliverable, nothing anywhere carries the marker ---
(
  base_env
  run_case genuine-no-deliverable-implement
  test "$status" = 1 || fail "no evidence anywhere must fail"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "genuine no-deliverable must set NO_DELIVERABLE=1"
)
(
  base_env
  export MODE=review
  run_case genuine-no-deliverable-review
  test "$status" = 1 || fail "no evidence anywhere must fail in review mode too"
  case "$output" in
    *"no deliverable"*"pull request review"*) ;;
    *) fail "review-mode no-deliverable message should name the missing review too" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "genuine no-deliverable must set NO_DELIVERABLE=1"
)

# ============================================================================
# Negative cases: each of the five inference clauses deleted from the
# script (#815 removed them for hosted lanes; the standalone legacy mode
# followed once every consumer passed ATTEMPT_ID) is tested with the shape
# that USED to satisfy it
# - a time-windowed PR, an issue closure, a status:needs-human label, a bare
# reply-mode bot comment, and a bare review - all WITHOUT this run's exact
# attempt-claim marker anywhere. Every one must be a genuine exact-mode
# no-deliverable, matching "An unrelated PR, old label, generic bot comment,
# issue closure, or review CANNOT satisfy validation" (#815 acceptance
# criteria).
# ============================================================================

# --- N1: an unrelated/time-windowed PR - updated recently, authored by the
# agent's own bot login, even referencing #NUM in its title - no longer
# satisfies the gate without the exact marker. This is also the #650
# generation-9 regression shape (a PR that merely mentions the issue number)
# generalized: no author or recency signal substitutes for the marker any
# more. ---
(
  base_env
  case_dir="$test_root/unrelated-time-windowed-pr-no-marker"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":7,"title":"Fix widget (#42)","body":"","updated_at":"2099-01-01T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case unrelated-time-windowed-pr-no-marker
  test "$status" = 1 || fail "a recently-updated PR merely referencing #NUM must not satisfy the gate without the exact marker"
  case "$output" in
    *"no deliverable"*) ;;
    *) fail "expected the no-deliverable message" ;;
  esac
  case "$output" in
    *"PR referencing #42"*) fail "the retired inference wording must not appear" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
)

# --- N2: an OLD/stale status:needs-human label, currently present and even
# recorded on the issue timeline, no longer satisfies the gate. ---
(
  base_env
  case_dir="$test_root/old-needs-human-label-no-marker"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"open","closed_at":null,"labels":[{"name":"status:needs-human"}]}
JSON
  cat > "$case_dir/timeline.json" <<'JSON'
[{"event":"labeled","label":{"name":"status:needs-human"},"created_at":"2020-01-01T00:00:00Z"}]
JSON
  run_case old-needs-human-label-no-marker
  test "$status" = 1 || fail "a status:needs-human label must not satisfy the gate without the exact marker"
  case "$output" in
    *"status:needs-human label applied"*) fail "the retired inference wording must not appear" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
)

# --- N3: a generic bot comment on a reply dispatch, from exactly the login
# the retired clause trusted, no longer satisfies the gate without the exact
# marker. ---
(
  base_env
  export MODE=reply
  case_dir="$test_root/generic-bot-comment-reply-no-marker"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":556,"user":{"login":"agent-lcars[bot]","type":"Bot"},"body":"Picked this up, working on it now."}]
JSON
  run_case generic-bot-comment-reply-no-marker
  test "$status" = 1 || fail "a generic bot comment must not satisfy the gate without the exact marker"
  case "$output" in
    *"posted a comment on"*) fail "the retired inference wording must not appear" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
)

# --- N3b: an explicit requires-human result is not a separate exact-mode
# outcome today. A worker may write a marked explanatory comment while the
# projector independently owns the status:needs-human label; the verifier
# accepts the exact evidence as a comment, never fabricates a "park" outcome
# from the label or prose. This freezes the current split for the lifecycle
# contract work: explicit parking is projector state, not worker validation.
(
  base_env
  case_dir="$test_root/exact-requires-human-comment-is-comment-outcome"
  mkdir -p "$case_dir"
  cat > "$case_dir/comments.json" <<'JSON'
[{"id":557,"user":{"login":"agent-lcars[bot]","type":"Bot"},"body":"I need maintainer direction before continuing.\n<!-- attempt-claim:g1:test-intent -->"}]
JSON
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"open","closed_at":null,"labels":[{"name":"status:needs-human"}]}
JSON
  run_case exact-requires-human-comment-is-comment-outcome
  test "$status" = 0 || fail "an exact marked requires-human comment should pass"
  case "$output" in
    *"comment carrying this run's attempt-claim marker"*) ;;
    *) fail "requires-human prose and a label must remain plain comment evidence, never a fabricated park outcome" ;;
  esac
  test ! -s "$GITHUB_OUTPUT" || fail "the verifier must publish no step outputs (outcome-kind/-reference were retired 2026-08-17; nothing maps them)"
)

# --- N4: the issue closing, with no marker on any comment, no longer
# satisfies the gate. ---
(
  base_env
  case_dir="$test_root/issue-closed-no-marker"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"state":"closed","closed_at":"2099-01-01T00:00:00Z","labels":[]}
JSON
  run_case issue-closed-no-marker
  test "$status" = 1 || fail "issue closure must not satisfy the gate without the exact marker"
  case "$output" in
    *"closed at"*) fail "the retired inference wording must not appear" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
)

# --- N5: a bare PR review on a review dispatch, from exactly the login the
# retired clause trusted, no longer satisfies the gate without the exact
# marker. ---
(
  base_env
  export MODE=review
  case_dir="$test_root/generic-review-no-marker"
  mkdir -p "$case_dir"
  cat > "$case_dir/reviews.json" <<'JSON'
[{"user":{"login":"agent-lcars[bot]","type":"Bot"},"submitted_at":"2099-01-01T00:00:00Z","body":"Looks good to me."}]
JSON
  run_case generic-review-no-marker
  test "$status" = 1 || fail "a generic review must not satisfy the gate without the exact marker"
  case "$output" in
    *"submitted a pull request review on"*) fail "the retired inference wording must not appear" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
)

# ============================================================================
# Exact-marker is the ONLY mode: the legacy time-window/login inference was
# deleted (every fleet consumer passes ATTEMPT_ID - agent-lcars's own lanes,
# homelab#697, sprinkles' exact-marker flip). No input combination may reach
# any weaker validation.
# ============================================================================

# Stray legacy env vars are ignored: exporting the full retired inference
# input set alongside ATTEMPT_ID changes nothing - a marker-less artifact
# that would have satisfied retired clause (a) (fresh referencing PR from
# the expected login) still fails as a genuine no-deliverable.
(
  base_env
  export STARTED_AT=2026-08-13T23:20:45Z
  export EXPECTED_COMMENT_LOGIN='agent-lcars[bot]'
  export RUNBOOK=unstick-prs
  export EXCLUDE_PR_AUTHOR='someone-else[bot]'
  export EXCLUDE_COMMENT_ID=12345
  case_dir="$test_root/stray-legacy-env-ignored"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":4392,"title":"fix: dossier photo (#42)","body":"","updated_at":"2026-08-13T23:26:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case stray-legacy-env-ignored
  test "$status" = 1 || fail "stray legacy env must never re-enable inference"
  case "$output" in
    *"verified via INFERENCE"*) fail "the retired inference notice must never appear" ;;
  esac
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "missing exact evidence must stay a genuine no-deliverable"
)

# Missing ATTEMPT_ID is a hard, fail-fast configuration error naming the
# exact-marker contract - never a fallback to weaker validation, and never
# a silent pass. Even the full retired legacy input pair cannot substitute.
(
  base_env
  unset ATTEMPT_ID
  export STARTED_AT=2026-08-13T23:20:45Z
  export EXPECTED_COMMENT_LOGIN='agent-lcars[bot]'
  case_dir="$test_root/missing-attempt-id"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":4392,"title":"fix: dossier photo (#42)","body":"","updated_at":"2026-08-13T23:26:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  run_case missing-attempt-id
  test "$status" = 1 || fail "a missing ATTEMPT_ID must fail hard"
  grep -q 'ATTEMPT_ID is required' <<<"$output" || fail "expected the missing-ATTEMPT_ID diagnostic"
  grep -q 'exact-marker-only' <<<"$output" || fail "the diagnostic must name the exact-marker contract"
  if grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" 2>/dev/null; then
    fail "a configuration error must not be recorded as a confirmed missing deliverable"
  fi
)
(
  base_env
  export ATTEMPT_ID=
  run_case empty-attempt-id
  test "$status" = 1 || fail "an empty ATTEMPT_ID must fail hard"
  grep -q 'ATTEMPT_ID is required' <<<"$output" || fail "expected the missing-ATTEMPT_ID diagnostic for the empty string too"
)

# ============================================================================
# Native work-item runs: NUM is empty (no issue/PR anchor). Only the
# PR-marker lookup runs; no /issues/ endpoint is ever called.
# ============================================================================

# --- W1: a native work item's PR-marker deliverable passes with NUM empty.
# comments.fail/reviews.fail would fail the run loudly if either lookup were
# reached, proving they are skipped, not merely empty. ---
(
  base_env
  export NUM=''
  case_dir="$test_root/native-work-item-pr-marker-found"
  mkdir -p "$case_dir"
  cat > "$case_dir/pulls.json" <<'JSON'
[{"number":99,"title":"Add healthz","body":"<!-- attempt-claim:g1:test-intent -->","updated_at":"2023-12-01T00:00:00Z","user":{"login":"agent-lcars[bot]","type":"Bot"}}]
JSON
  : > "$case_dir/comments.fail"
  : > "$case_dir/reviews.fail"
  run_case native-work-item-pr-marker-found
  test "$status" = 0 || fail "a native work item's PR-marker deliverable should pass with NUM empty"
  case "$output" in
    *"Deliverable evidence: PR carrying this run's attempt-claim marker"*) ;;
    *) fail "expected the PR evidence message for a native work item" ;;
  esac
)

# --- W2: a native work item with no matching PR fails as a genuine
# no-deliverable, without ever attempting the /issues/ comment lookup - if
# the NUM gate were missing, comments.fail below would turn this into a
# "FAILED lookup" error instead of a clean no-deliverable. ---
(
  base_env
  export NUM=''
  case_dir="$test_root/native-work-item-no-pr"
  mkdir -p "$case_dir"
  : > "$case_dir/comments.fail"
  : > "$case_dir/reviews.fail"
  run_case native-work-item-no-pr
  test "$status" = 1 || fail "a native work item with no PR-marker deliverable must fail"
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
  case "$output" in
    *"FAILED lookup"*) fail "no /issues/ endpoint should be called when NUM is empty" ;;
  esac
  case "$output" in
    *"produced no deliverable on this work item:"*) ;;
    *) fail "expected the final error to name 'this work item' when NUM is empty" ;;
  esac
  case "$output" in
    *"this work item: No PR carries"*) ;;
    *) fail "expected the checked-only-PR wording when NUM is empty" ;;
  esac
)

# --- W3: same as W2, but in review mode - the review lookup must also be
# skipped when NUM is empty, even though MODE=review would otherwise enable
# it. reviews.fail would surface as a FAILED lookup if the gate were missing.
(
  base_env
  export MODE=review
  export NUM=''
  case_dir="$test_root/native-work-item-review-mode-no-pr"
  mkdir -p "$case_dir"
  : > "$case_dir/comments.fail"
  : > "$case_dir/reviews.fail"
  run_case native-work-item-review-mode-no-pr
  test "$status" = 1 || fail "a native work item in review mode with no PR-marker deliverable must fail"
  grep -q '^NO_DELIVERABLE=1$' "$GITHUB_ENV" || fail "must be a genuine (not errored) no-deliverable"
  case "$output" in
    *"FAILED lookup"*) fail "no /issues/ or /pulls/.../reviews endpoint should be called when NUM is empty" ;;
  esac
  case "$output" in
    *"this work item: No PR carries"*) ;;
    *) fail "expected the checked-only-PR wording even in review mode when NUM is empty" ;;
  esac
)

echo "verify-deliverable.test.sh: all cases passed"
