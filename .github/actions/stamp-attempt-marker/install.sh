#!/usr/bin/env bash
# Install the marker-stamping `gh` wrapper ahead of the untrusted agent step.
# A separate script rather than an inline `run:` block so the install path is
# exercised by stamp.test.sh, the same way prepare-agent-dispatch splits
# action.yml from prepare.sh.
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
  if [ "$(cd "$(dirname "$candidate")" && pwd)" != "$bin_dir" ]; then
    real_gh="$candidate"
    break
  fi
done < <(type -aP gh)

if [ -z "$real_gh" ]; then
  echo "::error::No gh executable found to wrap for attempt-marker stamping" >&2
  exit 1
fi

install -m 0755 "$GITHUB_ACTION_PATH/gh" "$bin_dir/gh"

echo "AGENT_GH_REAL=$real_gh" >> "$GITHUB_ENV"
echo "$bin_dir" >> "$GITHUB_PATH"
