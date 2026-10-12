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
  export RUNTIME_OUTPUT="$dir/runtime-output"
  export RUNTIME_ENV="$dir/runtime-env"
  # Not `jlapenna/agent-lcars`, so assert-consumer-boundaries.sh takes its
  # fast "any other repository" path instead of requiring the canonical
  # agent-protocol symlink this fixture's fresh $WORKSPACE does not have.
  export REPOSITORY="octo/example"
  export GH_TOKEN="fake-gh-token"
  export CONSOLE_URL="https://lcars.test"
  export AGENT="Claude"
  export BUDGET_MINUTES=80 ARTIFACT_CHECKPOINT_MINUTES=15 FINALIZE_CHECKPOINT_MINUTES=70
  : > "$RUNTIME_OUTPUT"
  : > "$RUNTIME_ENV"

  bash "$RUNTIME_HELPERS_DIR/prepare-dispatch.sh"
  context_path="$RUNNER_TEMP/agent-dispatch/context.json"
}

# --- Native reply round: REPLY reaches the brief, budget raised -----------
# Today, `WORK && !ISSUE` forces REPLY='' unconditionally: a native item has
# no maintainer channel yet. The reply route (Task 2) gives it one, so this
# must survive into the emitted brief instead of being blanked.
export WORK='{"id":"01PREPAREDISPATCHTESTFIX1","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"octo/example"}}}'
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

# --- Reply budget raised to 16,384 -----------------------------------------
# `MAX_REPLY_CHARACTERS` was 4,000; raised to 16,384 to match
# `WORK_DESCRIPTION_MAX` (spec decision 5). A reply within the old budget
# but past it must now survive un-truncated.
long_reply="$(printf 'x%.0s' $(seq 1 8000))"
export REPLY="$long_reply"
run_prepare_dispatch native-reply-long

jq -e --arg reply "$long_reply" '.reply == $reply' "$context_path" >/dev/null ||
  fail "native reply budget: an 8,000-character reply was truncated below the raised 16,384 budget ($(jq -r '.reply | length' "$context_path"))"
jq -e '(.truncated // []) | index("reply") == null' "$context_path" >/dev/null ||
  fail "native reply budget: reply was reported truncated despite fitting the raised budget"

echo "scenario native-reply-long: OK"

echo "prepare-dispatch.test.sh: all scenarios passed"
