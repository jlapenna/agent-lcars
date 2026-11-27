#!/usr/bin/env bash
# Exercise the real verifier against paginated REST fixtures, including the
# exact author/attempt gates and URLs from the same verified object.
set -euo pipefail
runtime_dir=$(cd "$(dirname "$0")" && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir "$fixture_dir/bin"
cat > "$fixture_dir/bin/gh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "api repos/octo/example/pulls/42 --jq .user.login" ]]; then
  printf '%s\n' author >> "$FIXTURE_DIR/calls"
  [ "${FAIL_LOOKUP:-}" != author ] || { echo 'transient API error' >&2; exit 1; }
  # A warning on stderr must not become part of the login.
  echo 'warning: a newer gh is available' >&2
  cat "$FIXTURE_DIR/author"
  exit 0
fi
[[ "$*" == *"--paginate --slurp"* ]] || exit 12
case "$*" in
  *'pulls?state=all'*) name=prs ;;
  *'issues/42/comments'*) name=comments ;;
  *'pulls/42/reviews'*) name=reviews ;;
  *) exit 13 ;;
esac
printf '%s\n' "$name" >> "$FIXTURE_DIR/calls"
[ "${FAIL_LOOKUP:-}" != "$name" ] || { echo 'transient API error' >&2; exit 1; }
cat "$FIXTURE_DIR/$name.json"
FAKE
chmod +x "$fixture_dir/bin/gh"
export PATH="$fixture_dir/bin:$PATH" FIXTURE_DIR="$fixture_dir"
export LCARS_REVIEWER_LOGIN='agent-lcars-reviewer[bot]'
export AGENT=Codex REPO=octo/example NUM=42 MODE=reply ATTEMPT_ID=g7:octo/example#42/r7
export VERIFIED_OUTCOME_FILE="$fixture_dir/verified.json" RUNTIME_ENV="$fixture_dir/env"
marker="<!-- attempt-claim:${ATTEMPT_ID} -->"
reset_fixture() {
  for name in prs comments reviews; do echo '[[]]' > "$fixture_dir/$name.json"; done
  echo octocat > "$fixture_dir/author"
  : > "$fixture_dir/calls"
  : > "$RUNTIME_ENV"
  unset FAIL_LOOKUP
  LCARS_REVIEWER_LOGIN='agent-lcars-reviewer[bot]'
  MODE=reply
}
verify() { bash "$runtime_dir/verify-outcome.sh" > "$fixture_dir/output" 2>&1; }
assert_json() { jq -e "$1" "$VERIFIED_OUTCOME_FILE" >/dev/null; }
reset_fixture
# A bystander quoting the exact marker, or another bot attempt, is insufficient.
jq -cn --arg marker "$marker" '[[{id:1,user:{type:"User"},body:$marker},{id:2,user:{type:"Bot"},body:"<!-- attempt-claim:foreign -->"}]]' > "$fixture_dir/comments.json"
echo '{"outcome":"comment","outcomeReference":{"url":"https://evil.test"}}' > "$VERIFIED_OUTCOME_FILE"
if verify; then echo 'accepted foreign/human marker' >&2; exit 1; fi
[ ! -e "$VERIFIED_OUTCOME_FILE" ]
grep -Fq 'NO_DELIVERABLE=1' "$RUNTIME_ENV"
# Only page two contains the exact matching bot comment. A newer human URL
# must not be borrowed for a verified older bot artifact.
jq -cn --arg marker "$marker" '[[{id:120,user:{type:"User"},body:$marker,html_url:"https://evil.test"}], [{id:99,user:{type:"Bot"},body:$marker,html_url:"https://github.com/octo/example/pull/42#issuecomment-99"}]]' > "$fixture_dir/comments.json"
verify
assert_json '.outcome == "comment" and .outcomeReference == {kind:"comment",number:42,id:99,url:"https://github.com/octo/example/pull/42#issuecomment-99"}'
[ "$(grep -c '^comments$' "$fixture_dir/calls")" = 2 ] # Once per verification, including failed previous pass.
# A structured outcome carries the exact structured comment's own permalink.
for kind in park no-op; do
  reset_fixture
  jq -cn --arg marker "$marker" --arg kind "$kind" '[[{id:99,user:{type:"Bot"},body:$marker,html_url:"https://github.com/octo/example/issues/42#issuecomment-99"},{id:101,user:{type:"Bot"},body:($marker+" <!-- agent-result:v1:"+$kind+" -->"),html_url:"https://github.com/octo/example/issues/42#issuecomment-101"}]]' > "$fixture_dir/comments.json"
  verify
  assert_json ".outcome == \"$kind\" and .outcomeReference.id == 101 and .outcomeReference.url == \"https://github.com/octo/example/issues/42#issuecomment-101\""
done
# Partial implementation plus a blocker retains both exact artifact links.
reset_fixture
jq -cn --arg marker "$marker" '[[{number:12,user:{type:"Bot"},body:$marker}]]' > "$fixture_dir/prs.json"
jq -cn --arg marker "$marker" '[[{id:99,user:{type:"Bot"},body:($marker+" <!-- agent-result:v1:park -->"),html_url:"https://github.com/octo/example/issues/42#issuecomment-99"}]]' > "$fixture_dir/comments.json"
verify
assert_json '.outcome == "park" and .outcomeReference.number == 12 and .outcomeReference.related[0].id == 99'
# Matching reviews are accepted only in review mode.
reset_fixture
review_fixture() {
  jq -cn --arg marker "$marker" --arg state "$1" '[[{id:100,state:$state,user:{type:"Bot",login:"agent-lcars-reviewer[bot]"},body:$marker,html_url:"https://github.com/octo/example/pull/42#pullrequestreview-100"}]]' > "$fixture_dir/reviews.json"
}
review_fixture APPROVED
if verify; then echo 'accepted review in reply mode' >&2; exit 1; fi
! grep -Fxq reviews "$fixture_dir/calls"
# The review state is the verdict: an approval, a change request, or either
# one a later push dismissed.
for state in APPROVED CHANGES_REQUESTED DISMISSED; do
  reset_fixture
  MODE=review
  review_fixture "$state"
  verify
  assert_json '.outcome == "review" and .outcomeReference.url == "https://github.com/octo/example/pull/42#pullrequestreview-100"'
done
# A marker-stamped verdict from an implementation identity is not this review.
reset_fixture
MODE=review
review_fixture APPROVED
sed -i 's/agent-lcars-reviewer/agent-lcars/' "$fixture_dir/reviews.json"
if verify; then echo 'accepted implementation identity as reviewer' >&2; exit 1; fi
[ ! -e "$VERIFIED_OUTCOME_FILE" ]
grep -Fq 'NO_DELIVERABLE=1' "$RUNTIME_ENV"
# Review mode requires the negotiated reviewer identity; missing caller config
# fails closed without signaling a deliverable retry.
reset_fixture
MODE=review
LCARS_REVIEWER_LOGIN=''
review_fixture APPROVED
echo '{"outcome":"review","outcomeReference":{"url":"https://evil.test"}}' > "$VERIFIED_OUTCOME_FILE"
if verify; then echo 'accepted review mode without LCARS_REVIEWER_LOGIN' >&2; exit 1; fi
[ ! -e "$VERIFIED_OUTCOME_FILE" ]
[ ! -s "$RUNTIME_ENV" ]
grep -Fq 'LCARS_REVIEWER_LOGIN is required in review mode' "$fixture_dir/output"
# A COMMENT is not a verdict, whatever its body says.
reset_fixture
MODE=review
review_fixture COMMENTED
if verify; then echo 'accepted a COMMENT review as a verdict' >&2; exit 1; fi
[ ! -e "$VERIFIED_OUTCOME_FILE" ]
grep -Fq 'NO_DELIVERABLE=1' "$RUNTIME_ENV"
grep -Fq 'event is APPROVE or REQUEST_CHANGES' "$fixture_dir/output"
# GitHub refuses both on the reviewer's own pull request, so a COMMENT stands there.
reset_fixture
MODE=review
review_fixture COMMENTED
echo 'agent-lcars-reviewer[bot]' > "$fixture_dir/author"
verify
assert_json '.outcome == "review"'
# A failed author lookup is a failed lookup, never a verdict or a missing one.
reset_fixture
MODE=review
review_fixture APPROVED
export FAIL_LOOKUP=author
if verify; then echo 'accepted a review without reading the author' >&2; exit 1; fi
grep -Fq 'FAILED lookup' "$fixture_dir/output"
[ ! -s "$RUNTIME_ENV" ]
# Verification failures neither invent evidence nor collapse into no-deliverable.
reset_fixture
export FAIL_LOOKUP=comments
if verify; then echo 'accepted failed lookup' >&2; exit 1; fi
[ ! -e "$VERIFIED_OUTCOME_FILE" ]
grep -Fq 'FAILED lookup' "$fixture_dir/output"
[ ! -s "$RUNTIME_ENV" ]
# A real PR still counts if the optional blocker lookup fails.
jq -cn --arg marker "$marker" '[[{number:12,user:{type:"Bot"},body:$marker}]]' > "$fixture_dir/prs.json"
verify
assert_json '.outcome == "pull-request" and .outcomeReference.number == 12'
# Missing historical permalink remains success without an invented generic URL.
reset_fixture
jq -cn --arg marker "$marker" '[[{id:99,user:{type:"Bot"},body:$marker}]]' > "$fixture_dir/comments.json"
verify
assert_json '.outcome == "comment" and .outcomeReference == null'
# Native work has no GitHub comment/review anchor.
NUM=''
reset_fixture
if verify; then echo 'native result invented' >&2; exit 1; fi
[ "$(cat "$fixture_dir/calls")" = prs ]
echo 'exact outcome-reference verifier scenarios: OK'
