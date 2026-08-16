#!/usr/bin/env bash
# Install the marker-stamping `gh` wrapper ahead of the untrusted agent step.
# A separate script rather than an inline `run:` block so the install path is
# exercised by stamp.test.sh, the same way prepare-agent-dispatch splits
# action.yml from prepare.sh.
#
# #1268: the original install relied solely on prepending a directory to
# $GITHUB_PATH. That is not reliable enough. Runs 31962331339 (#1252) and
# 31967111276 (#1253) both opened correct pull requests that merged, and both
# were recorded as FAILURES because the wrapper never stamped them - with no
# warning, because a wrapper that is never invoked cannot warn. The wrapper's
# own logic was verified correct against those exact command shapes, so the
# break was interception, not parsing.
#
# So: replace `gh` where it actually lives when that is possible, which no
# PATH manipulation or login-shell profile can undo, and fall back to the
# PATH entry when the real binary's directory is not writable. Then VERIFY
# that one of them took effect and fail the handoff loudly if neither did.
# The whole point of this action is to remove "did the agent forget?" as an
# explanation; an install that silently no-ops puts it straight back.
set -euo pipefail
umask 077

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ACTION_PATH:?GITHUB_ACTION_PATH is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

bin_dir="$RUNNER_TEMP/agent-gh-marker"
mkdir -p "$bin_dir"

# Resolve the real gh while skipping this wrapper, so running the action
# twice cannot chain the wrapper to itself.
real_gh=''
while IFS= read -r candidate; do
  candidate_dir="$(cd "$(dirname "$candidate")" && pwd)"
  [ "$candidate_dir" = "$bin_dir" ] && continue
  # A previous in-place install leaves the wrapper at gh's own path; its
  # stashed original is the real binary, not the wrapper.
  if head -n 5 "$candidate" 2>/dev/null | grep -q 'marker-stamping-gh-wrapper'; then
    continue
  fi
  real_gh="$candidate"
  break
done < <(type -aP gh)

if [ -z "$real_gh" ]; then
  echo "::error::No gh executable found to wrap for attempt-marker stamping" >&2
  exit 1
fi

real_dir="$(cd "$(dirname "$real_gh")" && pwd)"
stashed="$bin_dir/gh.real"
mode="path-entry"

# Preferred: take over gh's own path. Survives a login shell rebuilding PATH,
# a tool that resets it, and any subprocess that resolves gh by absolute path.
if [ -w "$real_dir" ]; then
  cp -p "$real_gh" "$stashed"
  install -m 0755 "$GITHUB_ACTION_PATH/gh" "$real_gh"
  effective_real="$stashed"
  mode="in-place"
else
  install -m 0755 "$GITHUB_ACTION_PATH/gh" "$bin_dir/gh"
  effective_real="$real_gh"
  echo "$bin_dir" >> "$GITHUB_PATH"
fi

echo "AGENT_GH_REAL=$effective_real" >> "$GITHUB_ENV"

# Verify interception actually happened rather than assuming it. In
# path-entry mode $GITHUB_PATH does not affect THIS step's own PATH, so the
# check resolves gh against the same prepend the next step will get.
if [ "$mode" = "in-place" ]; then
  probe_path="$PATH"
else
  probe_path="$bin_dir:$PATH"
fi

resolved="$(PATH="$probe_path" command -v gh || true)"
if [ -z "$resolved" ] || ! head -n 5 "$resolved" 2>/dev/null | grep -q 'marker-stamping-gh-wrapper'; then
  echo "::error::attempt-marker wrapper is not intercepting gh (mode=$mode, resolved='${resolved:-none}'). A silent no-op here makes a correct run look like a failed one - see agent-lcars#1268." >&2
  exit 1
fi

echo "attempt-marker wrapper installed ($mode); gh resolves to $resolved"
