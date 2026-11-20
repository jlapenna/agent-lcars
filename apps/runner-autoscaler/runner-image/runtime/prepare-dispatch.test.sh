#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../../.." && pwd)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Minimal baked tree, the same shape direct-runner.test.sh builds: the
# runtime helpers plus the sibling `agents/shared/skills` directory the
# Dockerfile copies in, since prepare-dispatch.sh reads its protocol
# document and skill list relative to `$RUNTIME_HELPERS_DIR/..`.
baked="$tmp/baked"
mkdir -p "$baked/runtime"
cp -R "$here/." "$baked/runtime/"
mkdir -p "$baked/agents/shared/skills"
cp -R "$repo_root/agents/shared/skills/." "$baked/agents/shared/skills/"
bash "$repo_root/apps/runner-autoscaler/runner-image/package-anthropic-review.sh" \
  "$baked/agents/shared/skills/agent-protocol/reference/anthropic-code-review"
review_package="$baked/agents/shared/skills/agent-protocol/reference/anthropic-code-review"
cmp "$repo_root/third_party/anthropic-plugins/plugins/code-review/commands/code-review.md" "$review_package/upstream.md"
cmp "$repo_root/third_party/anthropic-plugins/plugins/code-review/LICENSE" "$review_package/LICENSE"
[ "$(cat "$review_package/revision")" = "$(git -C "$repo_root" rev-parse :third_party/anthropic-plugins)" ]

grep -Fq "$(cat "$review_package/revision")" "$review_package/README.md"

# A valid source checkout at a different locked revision must never package.
# Give the production packager an isolated parent index, keeping the real
# dependency checkout and its index untouched.
lock_fixture="$tmp/lock-fixture"
mkdir -p "$lock_fixture/apps/runner-autoscaler/runner-image" "$lock_fixture/third_party"
cp "$repo_root/apps/runner-autoscaler/runner-image/package-anthropic-review.sh" "$lock_fixture/apps/runner-autoscaler/runner-image/"
ln -s "$repo_root/third_party/anthropic-plugins" "$lock_fixture/third_party/anthropic-plugins"
git init --quiet "$lock_fixture"
git -C "$lock_fixture" update-index --add --cacheinfo \
  160000,1111111111111111111111111111111111111111,third_party/anthropic-plugins
if bash "$lock_fixture/apps/runner-autoscaler/runner-image/package-anthropic-review.sh" "$tmp/mismatched-package" > "$tmp/lock-error" 2>&1; then
  echo 'review dependency: packaging accepted a checkout that differs from the lock' >&2
  exit 1
fi
grep -Fq 'not at its locked revision' "$tmp/lock-error"

fail() {
  echo "$1" >&2
  exit 1
}

run_prepare_dispatch() {
  name="$1"
  dir="$tmp/$name"
  mkdir -p "$dir/workspace" "$dir/runner-temp"
  export HOME="$dir/home"
  mkdir -p "$HOME"
  export RUNNER_TEMP="$dir/runner-temp"
  export RUNTIME_HELPERS_DIR="$baked/runtime"
  export WORKSPACE="$dir/workspace"
  export RUNTIME_ENV="$dir/runtime-env"
  # Not `jlapenna/agent-lcars`, so assert-consumer-boundaries.sh takes its
  # fast "any other repository" path instead of requiring the canonical
  # agent-protocol symlink this fixture's fresh $WORKSPACE does not have.
  export REPOSITORY="octo/example"
  export GH_TOKEN="fake-gh-token"
  export CONSOLE_URL="https://lcars.test"
  export AGENT="Claude"
  export BUDGET_MINUTES=80
  : > "$RUNTIME_ENV"
  # Production hands the Work payload over as a file (direct-runner.sh), not
  # an environment string, which Linux limits to 128 KiB.
  export WORK_FILE="$dir/work.json"
  printf '%s' "$WORK" > "$WORK_FILE"

  bash "$RUNTIME_HELPERS_DIR/prepare-dispatch.sh" || return $?
  context_path="$RUNNER_TEMP/agent-dispatch/context.json"
}

# --- Native reply round: REPLY reaches the brief, budget raised -----------
# Today, `WORK && !ISSUE` forces REPLY='' unconditionally: a native item has
# no maintainer channel yet. The reply route (Task 2) gives it one, so this
# must survive into the emitted brief instead of being blanked.
WORK='{"id":"01PREPAREDISPATCHTESTFIX1","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"octo/example"}}}'
# Empty, not unset: direct-runner.sh exports ISSUE='' for a native (`work`)
# anchor -- see its ANCHOR_TYPE=work case -- and prepare-dispatch.sh reads
# it unconditionally under `set -u`.
export ISSUE=''
export REPLY='Use Firestore.'
export MODE='reply'
export RUNBOOK=''
export CONTEXT=''
run_prepare_dispatch native-reply

jq -e --arg reply "$REPLY" '.reply == $reply' "$context_path" >/dev/null ||
  fail "native reply: brief blanked REPLY despite a native maintainer channel ($(cat "$context_path"))"
jq -e '.mode == "reply"' "$context_path" >/dev/null ||
  fail "native reply: brief lost mode:reply ($(cat "$context_path"))"

echo "scenario native-reply: OK"

# --- Work text reaches the brief whole ------------------------------------
# The brief used to clamp the anchor body to 6,000 characters, the reply to
# 16,384 and context to 2,000. Each now arrives whole, at sizes past the
# 128 KiB single-string limit for the description (which travels by file)
# and near the Work API's 120 KiB per-parameter budget for reply and context.
long_description="$(head -c 300000 /dev/zero | tr '\0' 'd')"
long_reply="$(head -c 120000 /dev/zero | tr '\0' 'r')"
long_context="$(head -c 120000 /dev/zero | tr '\0' 'c')"
saved_work="$WORK"
printf '%s' "$long_description" > "$tmp/long-description.txt"
WORK="$(jq -c --rawfile d "$tmp/long-description.txt" '.spec.description = $d' <<<"$saved_work")"
export REPLY="$long_reply"
export CONTEXT="$long_context"
run_prepare_dispatch native-long-text

jq -e '(.anchor.body | length) == 300000 and (.reply | length) == 120000 and (.context | length) == 120000' "$context_path" >/dev/null ||
  fail "native long text: brief did not carry the description, reply and context whole"
jq -e 'has("truncated") | not' "$context_path" >/dev/null ||
  fail "native long text: brief still reports a truncation list"
grep -Fq 'dispatch-brief: truncated' "$context_path" &&
  fail "native long text: brief still contains a truncation marker"
WORK="$saved_work"
export CONTEXT=''

echo "scenario native-long-text: OK"

# --- Runtime block carries only what the protocol reads ------------------
jq -e '.runtime | keys == ["budget_minutes", "deadline", "started_at"] and .budget_minutes == 80' "$context_path" >/dev/null ||
  fail "runtime block drifted from started_at/deadline/budget_minutes ($(jq -c .runtime "$context_path"))"
jq -e '(has("prior_terminal_state") or has("deliveryHandoffVersion")) | not' "$context_path" >/dev/null ||
  fail "brief still carries a retired field ($(jq -c 'keys' "$context_path"))"

echo "scenario runtime-block: OK"

# The trusted review dependency is selected from the baked image, never the
# consumer checkout. Missing artifacts must stop review preparation instead of
# silently launching the old generic review; other modes do not load them.
export MODE='review'
run_prepare_dispatch review-procedure
review_dir="$baked/agents/shared/skills/agent-protocol/reference/anthropic-code-review"
grep -Fxq "AGENT_REVIEW_PATH=$review_dir/README.md" "$RUNTIME_ENV" ||
  fail "review: procedure path did not resolve from the baked image"
for artifact in README.md upstream.md LICENSE revision; do
  mv "$review_dir/$artifact" "$tmp/review-artifact"
  if run_prepare_dispatch "review-missing-$artifact" > "$tmp/review-error" 2>&1; then
    fail "review: missing $artifact did not stop dispatch preparation"
  fi
  grep -Fq "Anthropic review procedure is missing or empty at $review_dir/$artifact" "$tmp/review-error" ||
    fail "review: missing $artifact did not name the failed artifact"
  [ ! -s "$RUNTIME_ENV" ] || fail "review: missing $artifact exported a partial context"
  export MODE='implement'
  run_prepare_dispatch "implement-without-$artifact"
  if grep -q '^AGENT_REVIEW_PATH=' "$RUNTIME_ENV"; then
    fail "implement: loaded the review-only procedure"
  fi
  mv "$tmp/review-artifact" "$review_dir/$artifact"
  export MODE='review'
done
echo "scenario review-procedure: OK"

# Linear source identity stays distinct from the native Work/checkout anchor.
WORK='{"id":"01PREPAREDISPATCHTESTFIX1","spec":{"title":"SPR-84: Fix source","description":"Current admitted issue body","pipeline":"claude","target":{"repo":"octo/example"}},"issue":{"reference":{"tracker":"linear","organizationId":"11111111-1111-4111-8111-111111111111","issueId":"44444444-4444-4444-8444-444444444444"},"identifier":"SPR-84","url":"https://linear.app/example/issue/SPR-84","title":"Fix source","state":"open","updatedAt":"2026-11-04T10:00:00Z"}}'
export MODE='implement'
export REPLY=''
run_prepare_dispatch linear-source
jq -e '.anchor.type == "work" and .anchor.target_repo == "octo/example" and .source_issue.reference.tracker == "linear" and .source_issue.identifier == "SPR-84" and .source_issue.reference.issueId == "44444444-4444-4444-8444-444444444444" and .anchor.body == "Current admitted issue body"' "$context_path" >/dev/null ||
  fail "Linear source lost its typed identity or changed the checkout anchor"

# Even callers passing an entire source snapshot cannot duplicate its prose
# outside the bounded anchor body. Full evidence stays in `lcars work source`.
WORK="$(jq -c '.issue.description = ("e" * 65536) | .issue.labels = [{id:"label",name:"label"}] | .issue.assignees = [{id:"actor",name:"actor"}]' <<<"$WORK")"
run_prepare_dispatch linear-source-large
jq -e '(.source_issue | has("description") or has("labels") or has("assignees")) | not' "$context_path" >/dev/null ||
  fail "Source metadata duplicated unbounded source prose into the worker brief"

# --- GitHub anchor: full body, all criteria, every new comment -----------
# The brief used to keep 6,000 body characters, 40 acceptance criteria, the
# last five new comments at 1,000 characters each and 2,000 characters of
# the latest agent result. GitHub's own limits (65,536 characters per body)
# now bound them, and comment pages from `--paginate` are flattened.
fake_bin="$tmp/fake-gh-bin"
mkdir -p "$fake_bin"
github_body="$(printf -- '- [ ] criterion %s\n' $(seq 1 60))$(head -c 60000 /dev/zero | tr '\0' 'b')"
comment_body="$(head -c 65000 /dev/zero | tr '\0' 'm')"
jq -n --arg body "$github_body" '{number: 7, title: "GitHub title", body: $body, state: "open", html_url: "https://github.com/octo/example/issues/7", labels: [], assignees: []}' > "$tmp/fake-issue.json"
jq -n --arg body "$comment_body" '[range(0; 100) | {id: ., html_url: "https://github.com/octo/example/issues/7#c\(.)", created_at: "2026-11-01T00:00:01Z", updated_at: "2026-11-01T00:00:01Z", user: {login: "maintainer", type: "User"}, body: $body}]' > "$tmp/fake-page-1.json"
jq -n --arg body "$comment_body" '[range(100; 107) | {id: ., html_url: "https://github.com/octo/example/issues/7#c\(.)", created_at: "2026-11-01T00:00:02Z", updated_at: "2026-11-01T00:00:02Z", user: {login: "maintainer", type: "User"}, body: ("<!-- agent-result:v1:park:x --> " + $body)}]' > "$tmp/fake-page-2.json"
cat > "$fake_bin/gh" <<FAKEGH
#!/usr/bin/env bash
case "\$2" in
  */comments*) cat "$tmp/fake-page-1.json" "$tmp/fake-page-2.json" ;;
  *) cat "$tmp/fake-issue.json" ;;
esac
FAKEGH
chmod +x "$fake_bin/gh"
saved_path="$PATH"
export PATH="$fake_bin:$PATH"
WORK="$(jq -c --arg body "$github_body" '{spec: {title: "GitHub title", description: $body, pipeline: "claude", target: {repo: "octo/example"}}}' <<<'{}')"
export ISSUE='7'
export MODE='implement'
export REPLY=''
export CONTEXT='agent-lcars:github-comments-since:v1:2026-11-01T00:00:00.000Z'
run_prepare_dispatch github-long-thread
export PATH="$saved_path"

jq -e --arg body "$github_body" '.anchor.body == $body and (.anchor.acceptance_criteria | length) == 60' "$context_path" >/dev/null ||
  fail "github: anchor body or acceptance criteria were shortened"
jq -e '(.new_comments | length) == 107 and all(.new_comments[]; (.body | length) >= 65000)' "$context_path" >/dev/null ||
  fail "github: new comments were windowed or clamped ($(jq '.new_comments | length' "$context_path"))"
jq -e '(.latest_agent_result.body | length) > 65000 and .latest_agent_result.id == 106' "$context_path" >/dev/null ||
  fail "github: latest agent result was clamped or missed the second page"

echo "scenario github-long-thread: OK"

echo "prepare-dispatch.test.sh: all scenarios passed"
