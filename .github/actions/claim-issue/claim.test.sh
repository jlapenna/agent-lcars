#!/usr/bin/env bash
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_GH_DIR/calls"

if [ "$1" != "api" ]; then
  exit 64
fi
case "$2" in
  */assignees)
    payload="$(cat)"
    printf '%s\n' "$payload" > "$FAKE_GH_DIR/assignee-payload.json"
    jq -e --arg login "$EXPECTED_LOGIN" \
      '. == {assignees: [$login]}' <<<"$payload" >/dev/null
    if [ -f "$FAKE_GH_DIR/assignment.fail" ]; then
      exit 1
    fi
    printf '%s\n' '{"assignees":[]}'
    ;;
  */comments)
    printf '%s\n' '902'
    ;;
  *) exit 64 ;;
esac
FAKE_GH
chmod +x "$fake_bin/gh"
export PATH="$fake_bin:$PATH"

run_case() {
  local name="$1"
  local post_pickup_comment="${2:-false}"
  local case_dir="$test_root/$name"
  mkdir -p "$case_dir"
  export FAKE_GH_DIR="$case_dir"
  export GITHUB_OUTPUT="$case_dir/github-output"
  export EXPECTED_LOGIN='jclaw-bot'
  export GH_TOKEN=test-token
  export REPO=example/repo
  export NUM=42
  export CLAIM_LOGIN="$EXPECTED_LOGIN"
  export POST_PICKUP_COMMENT="$post_pickup_comment"
  export AGENT=Codex
  export RUN_URL=https://github.com/example/repo/actions/runs/123
  : > "$GITHUB_OUTPUT"
  : > "$FAKE_GH_DIR/calls"
  set +e
  output="$(bash "$action_dir/claim.sh" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output" > "$case_dir/output"
}

run_case assignment-success
test "$status" = 0
grep -qx 'claimed=true' "$GITHUB_OUTPUT"
grep -qx 'pickup-comment-id=' "$GITHUB_OUTPUT"
jq -e '. == {assignees: ["jclaw-bot"]}' \
  "$FAKE_GH_DIR/assignee-payload.json" >/dev/null
if grep -q -- '--silent\|assignees\[\]' "$FAKE_GH_DIR/calls"; then
  echo 'claim must use an explicit JSON body without gh --silent' >&2
  exit 1
fi

run_case pickup-comment true
grep -qx 'claimed=true' "$GITHUB_OUTPUT"
grep -qx 'pickup-comment-id=902' "$GITHUB_OUTPUT"
grep -q '/comments' "$FAKE_GH_DIR/calls"

mkdir -p "$test_root/assignment-failure"
: > "$test_root/assignment-failure/assignment.fail"
run_case assignment-failure
test "$status" = 0
grep -qx 'claimed=false' "$GITHUB_OUTPUT"
grep -q 'Could not assign jclaw-bot' "$FAKE_GH_DIR/output"

echo 'claim.test.sh: all cases passed'
