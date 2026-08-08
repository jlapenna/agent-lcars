#!/usr/bin/env bash

set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/opencode" <<'FAKE_OPENCODE'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_CALLS"
if [ "$1 $2" = "session list" ]; then
  cat "$FAKE_SESSIONS"
elif [ "$1" = export ] && [ "$3" = --sanitize ]; then
  jq -n --arg id "$2" '{info:{id:$id},messages:[{info:{role:"assistant"},parts:[{type:"tool",tool:"bash"},{type:"text",text:"done"}]}]}'
else
  echo "unexpected opencode invocation: $*" >&2
  exit 64
fi
FAKE_OPENCODE
chmod +x "$fake_bin/opencode"
export PATH="$fake_bin:$PATH"

export FAKE_CALLS="$test_root/calls"
export FAKE_SESSIONS="$test_root/sessions.json"
workspace="$test_root/workspace"
mkdir -p "$workspace" "$test_root/runner-temp"
cat > "$FAKE_SESSIONS" <<JSON
[{"id":"ses_current","title":"current","directory":"$workspace","time":{"updated":1786147800000}},{"id":"ses_old","title":"old","directory":"$workspace","time":{"updated":1786140000000}},{"id":"ses_other","title":"other","directory":"/other","time":{"updated":1786147800000}}]
JSON

export RUNNER_TEMP="$test_root/runner-temp"
export GITHUB_OUTPUT="$test_root/github-output"
export GITHUB_WORKSPACE="$workspace"
export GITHUB_RUN_ID=12345
export ISSUE=523
export STARTED_AT=2026-08-08T00:00:00Z

bash "$action_dir/archive.sh"

archive_dir="$(sed -n 's/^path=//p' "$GITHUB_OUTPUT")"
test -f "$archive_dir/sessions/ses_current.json"
test ! -e "$archive_dir/sessions/ses_old.json"
grep -qx 'has-sessions=true' "$GITHUB_OUTPUT"
grep -q '^export ses_current --sanitize$' "$FAKE_CALLS"
jq -e '
  .schema == "agent-lcars.opencode-trajectory/v1" and
  .run_id == "12345" and
  .issue == "523" and
  .selected_sessions == 1 and
  .exported_sessions == 1 and
  .failed_exports == 0 and
  .sessions[0].id == "ses_current"
' "$archive_dir/manifest.json" >/dev/null

echo "archive.test.sh: all cases passed"
