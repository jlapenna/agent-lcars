#!/usr/bin/env bash
# Exercises the wrapper against a fake `gh` that records every call and keeps
# artifact bodies in files, so the assertions are about what the wrapper
# actually did to the artifact - not about which flags it happened to parse.

set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/fake"
mkdir -p "$fake_bin"
calls="$test_root/calls"
pr_body="$test_root/pr-body"
comment_body="$test_root/comment-body"
: > "$calls"

cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "$CALLS"
if [ -n "${FAIL_ARTIFACT:-}" ]; then
  echo "fake gh: refusing to create" >&2
  exit 9
fi
case "$1 $2" in
  "pr create")
    # Store whatever body the caller passed (always the last argument here),
    # so a pre-marked body can be seeded through the wrapper.
    printf '%s' "${*: -1}" > "$PR_BODY"
    echo "https://github.com/example/consumer/pull/42"
    ;;
  "issue comment" | "pr comment")
    printf '%s\n' "parked: blocked on a credential" > "$COMMENT_BODY"
    echo "https://github.com/example/consumer/issues/7#issuecomment-991"
    ;;
  "pr view") cat "$PR_BODY" ;;
  "pr edit")
    # `--body <value>` is the last pair this wrapper passes.
    printf '%s' "${*: -1}" > "$PR_BODY"
    ;;
  "api repos/example/consumer/issues/comments/991") cat "$COMMENT_BODY" ;;
  "api --method")
    printf '%s' "${*: -1}" | sed 's/^body=//' > "$COMMENT_BODY"
    ;;
  *) echo "unexpected fake gh call: $*" >&2; exit 64 ;;
esac
FAKE_GH
chmod +x "$fake_bin/gh"

export CALLS="$calls" PR_BODY="$pr_body" COMMENT_BODY="$comment_body"
export AGENT_GH_REAL="$fake_bin/gh"
wrapper="$action_dir/gh"

attempt_id='g3:jlapenna/agent-lcars#1173/r3'
marker="<!-- attempt-claim:${attempt_id} -->"

# --- Inert without the per-step opt-in -------------------------------------
# The post-agent gates run with ATTEMPT_ID set but no AGENT_MARKER_STAMPING.
# If the wrapper stamped there, the deliverable gate could be satisfied by the
# gate's own failure comment.
ATTEMPT_ID="$attempt_id" "$wrapper" issue comment 7 -b "gate report" >/dev/null
if grep -Fq "attempt-claim" "$comment_body"; then
  echo "wrapper stamped without AGENT_MARKER_STAMPING=1" >&2
  exit 1
fi

# --- Inert with no ATTEMPT_ID ----------------------------------------------
AGENT_MARKER_STAMPING=1 ATTEMPT_ID='' "$wrapper" pr create --title t --body b >/dev/null
if grep -Fq "attempt-claim" "$pr_body"; then
  echo "wrapper stamped with an empty ATTEMPT_ID" >&2
  exit 1
fi

# --- A created pull request gets the marker --------------------------------
: > "$calls"
url="$(AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" pr create --title t --body "Implements #1173.")"

# The agent must still see the real command's own output, unchanged: it reads
# this URL to report its deliverable.
test "$url" = "https://github.com/example/consumer/pull/42"
grep -Fq "$marker" "$pr_body"
# ...appended to the body the agent wrote, never replacing it.
grep -Fq "Implements #1173." "$pr_body"

# --- A created comment gets the marker -------------------------------------
url="$(AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" issue comment 7 -b "parked: blocked on a credential")"
test "$url" = "https://github.com/example/consumer/issues/7#issuecomment-991"
grep -Fq "$marker" "$comment_body"
grep -Fq "parked: blocked on a credential" "$comment_body"

# --- Idempotent: a marker the agent already wrote is not duplicated ---------
# The prompt still asks the agent to stamp the marker itself; an agent that
# complies must not end up with the marker twice in its PR body.
AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" pr create --title t --body "Agent wrote its own marker.

$marker" >/dev/null
test "$(grep -c -F "attempt-claim" "$pr_body")" -eq 1

# --- A marker for a DIFFERENT attempt does not count as already-stamped -----
# Clause 0 names one specific attempt, so a stale marker left by a previous
# generation must not suppress this one.
AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" pr create --title t --body "Stale.

<!-- attempt-claim:g1:someone-else -->" >/dev/null
grep -Fq "$marker" "$pr_body"

# --- Read-only and unrelated subcommands are never rewritten ---------------
: > "$calls"
AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" pr view "https://github.com/example/consumer/pull/42" --json body >/dev/null
test "$(wc -l < "$calls")" -eq 1
grep -Fxq "pr view https://github.com/example/consumer/pull/42 --json body" "$calls"

# --- Failing commands keep their exit status --------------------------------
# Both the pass-through path and the artifact path: a wrapper that swallowed a
# non-zero status would hide a failed `gh pr create` from the agent.
set +e
AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" "$wrapper" issue nonsense >/dev/null 2>&1
passthrough_status=$?
FAIL_ARTIFACT=1 AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" pr create --title t --body b >/dev/null 2>&1
artifact_status=$?
set -e
test "$passthrough_status" -eq 64
test "$artifact_status" -eq 9

echo "stamp-attempt-marker: ok"

# --- The install path, end to end -------------------------------------------
# Everything above drives the wrapper directly with AGENT_GH_REAL preset. This
# runs the real install.sh the action invokes, then calls `gh` through the
# PATH entry it published - so a wrapper that is installed wrong, or resolves
# the wrong underlying gh, fails here rather than in production.
install_root="$test_root/install"
mkdir -p "$install_root/runner-temp"

RUNNER_TEMP="$install_root/runner-temp" \
  GITHUB_ACTION_PATH="$action_dir" \
  GITHUB_ENV="$install_root/github-env" \
  GITHUB_PATH="$install_root/github-path" \
  PATH="$fake_bin:$PATH" \
  bash "$action_dir/install.sh"

installed_dir="$install_root/runner-temp/agent-gh-marker"
test -x "$installed_dir/gh"
grep -Fxq "AGENT_GH_REAL=$fake_bin/gh" "$install_root/github-env"
grep -Fxq "$installed_dir" "$install_root/github-path"

# Resolving `gh` through the published PATH entry must reach the wrapper, and
# the wrapper must reach the fake underneath it - not recurse into itself.
: > "$calls"
unset AGENT_GH_REAL
url="$(PATH="$installed_dir:$fake_bin:$PATH" \
  AGENT_GH_REAL="$(sed -n 's/^AGENT_GH_REAL=//p' "$install_root/github-env")" \
  AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  gh pr create --title t --body "Installed path.")"
test "$url" = "https://github.com/example/consumer/pull/42"
grep -Fq "$marker" "$pr_body"
export AGENT_GH_REAL="$fake_bin/gh"

# Running the installer twice must not chain the wrapper to itself: the
# recorded real gh stays the fake, never the wrapper we just installed.
: > "$install_root/github-env"
RUNNER_TEMP="$install_root/runner-temp" \
  GITHUB_ACTION_PATH="$action_dir" \
  GITHUB_ENV="$install_root/github-env" \
  GITHUB_PATH="$install_root/github-path" \
  PATH="$installed_dir:$fake_bin:$PATH" \
  bash "$action_dir/install.sh"
grep -Fxq "AGENT_GH_REAL=$fake_bin/gh" "$install_root/github-env"

echo "stamp-attempt-marker: install ok"
