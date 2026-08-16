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
    # Record whatever body the caller supplied, however it was supplied.
    prev=''; body=''
    for a in "$@"; do
      case "$prev" in
        --body | -b) body="$a" ;;
        --body-file | -F) if [ "$a" = - ]; then body="$(cat)"; else body="$(cat "$a")"; fi ;;
      esac
      prev="$a"
    done
    printf '%s' "$body" > "$COMMENT_BODY"
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
fail_msg() { echo "$*" >&2; exit 1; }

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

# --- A takeover or progress comment must NOT be stamped ---------------------
# This is the regression #1213 shipped and run 31950517581 exposed: the
# takeover comment is a run's FIRST action, so stamping every comment
# satisfies verify-deliverable before any work happens, on every run.
# agent-protocol.md §5: "never your takeover or progress comment".
: > "$comment_body"
url="$(AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" issue comment 7 -b "🤖 picking up #7. Will post one edited progress comment.")"
test "$url" = "https://github.com/example/consumer/issues/7#issuecomment-991"
if grep -Fq "attempt-claim" "$comment_body"; then
  echo "wrapper stamped a takeover comment - the deliverable gate now passes itself" >&2
  exit 1
fi

# --- A comment the agent declared a RESULT does get the marker --------------
# The evidence-backed no-op's whole deliverable is a comment, and the protocol
# already has a machine-readable way for the agent to say so.
url="$(AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" issue comment 7 -b "Already fixed in abc123.

<!-- agent-result:v1:no-op -->")"
test "$url" = "https://github.com/example/consumer/issues/7#issuecomment-991"
grep -Fq "$marker" "$comment_body"
grep -Fq "Already fixed in abc123." "$comment_body"

# ...including when the body arrives via --body-file, and via stdin, which the
# wrapper must replay so the real gh still receives it.
: > "$comment_body"
result_file="$test_root/result-body"
printf 'Nothing to do.\n\n<!-- agent-result:v1:no-op -->\n' > "$result_file"
AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" issue comment 7 --body-file "$result_file" >/dev/null
grep -Fq "$marker" "$comment_body"

: > "$comment_body"
AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$wrapper" issue comment 7 -F - >/dev/null <<'STDIN_BODY'
Nothing to do.

<!-- agent-result:v1:no-op -->
STDIN_BODY
grep -Fq "$marker" "$comment_body"
grep -Fq "Nothing to do." "$comment_body"

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

# Fall-back mode: when gh's own directory is not writable the installer
# cannot take over its path, so it publishes a PATH entry instead. Made
# explicit here because in-place is now preferred whenever it is possible
# (#1268), and that path has its own case further down.
chmod a-w "$fake_bin"
RUNNER_TEMP="$install_root/runner-temp" \
  GITHUB_ACTION_PATH="$action_dir" \
  GITHUB_ENV="$install_root/github-env" \
  GITHUB_PATH="$install_root/github-path" \
  PATH="$fake_bin:$PATH" \
  bash "$action_dir/install.sh"
chmod u+w "$fake_bin"

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
chmod a-w "$fake_bin"
RUNNER_TEMP="$install_root/runner-temp" \
  GITHUB_ACTION_PATH="$action_dir" \
  GITHUB_ENV="$install_root/github-env" \
  GITHUB_PATH="$install_root/github-path" \
  PATH="$installed_dir:$fake_bin:$PATH" \
  bash "$action_dir/install.sh"
chmod u+w "$fake_bin"
grep -Fxq "AGENT_GH_REAL=$fake_bin/gh" "$install_root/github-env"

echo "stamp-attempt-marker: install ok"

# --- #1268: in-place install takes over gh's own path ---------------------
# PATH-only interception is not enough. Runs 31962331339 and 31967111276 both
# merged correct PRs and were scored as failures because the wrapper was never
# invoked - and a wrapper that is never invoked cannot warn. In-place install
# survives a login shell rebuilding PATH and absolute-path invocations.
inplace_root="$test_root/inplace"
mkdir -p "$inplace_root/runner-temp" "$inplace_root/bin"
cp "$fake_bin/gh" "$inplace_root/bin/gh"

RUNNER_TEMP="$inplace_root/runner-temp" \
  GITHUB_ACTION_PATH="$action_dir" \
  GITHUB_ENV="$inplace_root/github-env" \
  GITHUB_PATH="$inplace_root/github-path" \
  PATH="$inplace_root/bin:$PATH" \
  bash "$action_dir/install.sh" > "$inplace_root/out" 2>&1 ||
  { echo "in-place install failed"; cat "$inplace_root/out"; exit 1; }

grep -q "in-place" "$inplace_root/out" || fail_msg "expected an in-place install into a writable bin dir"
# gh's own path is now the wrapper...
head -n 5 "$inplace_root/bin/gh" | grep -q 'marker-stamping-gh-wrapper' ||
  { echo "gh's own path was not replaced by the wrapper" >&2; exit 1; }
# ...and the real binary was stashed, with AGENT_GH_REAL pointing at it.
test -x "$inplace_root/runner-temp/agent-gh-marker/gh.real"
grep -q "^AGENT_GH_REAL=$inplace_root/runner-temp/agent-gh-marker/gh.real$" "$inplace_root/github-env" ||
  { echo "AGENT_GH_REAL does not point at the stashed real gh" >&2; exit 1; }
# In-place mode must NOT also publish a PATH entry - nothing needs it.
test ! -s "$inplace_root/github-path"

# Stamping still works end to end through the replaced path.
: > "$pr_body"
url="$(AGENT_GH_REAL="$inplace_root/runner-temp/agent-gh-marker/gh.real" \
  AGENT_MARKER_STAMPING=1 ATTEMPT_ID="$attempt_id" \
  "$inplace_root/bin/gh" pr create --title t --body "In-place body.")"
test "$url" = "https://github.com/example/consumer/pull/42"
grep -Fq "$marker" "$pr_body"

# Re-running the installer must not chain the wrapper to itself: the stashed
# real gh must still be the fake, never the wrapper.
RUNNER_TEMP="$inplace_root/runner-temp" \
  GITHUB_ACTION_PATH="$action_dir" \
  GITHUB_ENV="$inplace_root/github-env2" \
  GITHUB_PATH="$inplace_root/github-path2" \
  PATH="$inplace_root/bin:$PATH" \
  bash "$action_dir/install.sh" >/dev/null 2>&1
head -n 5 "$inplace_root/runner-temp/agent-gh-marker/gh.real" | grep -q 'marker-stamping-gh-wrapper' &&
  { echo "installer chained the wrapper to itself on re-run" >&2; exit 1; }

# --- #1268: a non-intercepting install must fail the handoff loudly --------
# This is the case that shipped the bug. Silence here is the whole defect.
noop_root="$test_root/noop"
mkdir -p "$noop_root/runner-temp" "$noop_root/bin"
cp "$fake_bin/gh" "$noop_root/bin/gh"
chmod a-w "$noop_root/bin"
# Sabotage the wrapper source so the installed copy carries no sentinel; the
# verification must notice rather than reporting success.
sabotaged="$noop_root/action"
mkdir -p "$sabotaged"
cp -r "$action_dir/." "$sabotaged/"
grep -v 'marker-stamping-gh-wrapper' "$action_dir/gh" > "$sabotaged/gh"
chmod +x "$sabotaged/gh"

set +e
RUNNER_TEMP="$noop_root/runner-temp" \
  GITHUB_ACTION_PATH="$sabotaged" \
  GITHUB_ENV="$noop_root/github-env" \
  GITHUB_PATH="$noop_root/github-path" \
  PATH="$noop_root/bin:$PATH" \
  bash "$sabotaged/install.sh" > "$noop_root/out" 2>&1
noop_status=$?
set -e
chmod u+w "$noop_root/bin"
test "$noop_status" -ne 0 || { echo "a non-intercepting install must fail, not warn" >&2; exit 1; }
grep -q "not intercepting gh" "$noop_root/out" ||
  { echo "expected the non-interception error"; cat "$noop_root/out"; exit 1; }

echo "stamp-attempt-marker: interception ok"
