#!/usr/bin/env bash
# Artifact-boundary contract for the pinned OpenCode CLI, global standing
# instructions, context lifecycle hooks, automatic compaction, and continuation.
# It proves framework delivery and hook execution, not model obedience.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
opencode_bin="${OPENCODE_BIN:-/usr/local/bin/opencode}"
expected_version="$(tr -d '\r\n' < "$here/opencode-version")"
expected_version="${expected_version#v}"
lib_dir="${HOOK_TEST_LIB_DIR:-/usr/local/lib/agent-lcars}"
event_timeout_seconds=30
framework_timeout_seconds=60
version_timeout_seconds=10
provider_start_timeout_seconds=10

fail() {
  echo "FAIL: $1" >&2
  exit "${2:-1}"
}

test -x "$opencode_bin" || fail "OpenCode executable is unavailable at $opencode_bin"
actual_version="$(timeout -k 2s "${version_timeout_seconds}s" "$opencode_bin" --version)" || {
  version_status=$?
  fail "pinned OpenCode version probe did not complete (exit $version_status)" "$version_status"
}
[ "$actual_version" = "$expected_version" ] ||
  fail "test must run against pinned OpenCode $expected_version"

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  # Detached telemetry clients can outlive the CLI and recreate files during rm.
  # Keep the scratch intact when ownership or retirement cannot be established.
  python3 "$here/drain-hook-test-clients.py" "$tmp" || return 1
  rm -rf "$tmp"
  if [ -n "${HOOK_TEST_LIB_DIR:-}" ]; then
    printf 'drained\n' > "$lib_dir/.hook-smoke-drained"
  fi
}
trap cleanup EXIT

source "${here}/hook-telemetry-assertions.sh"
source_config_dir="${HOOK_TEST_OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
test -f "$source_config_dir/opencode.json" || fail "runner-global OpenCode config is missing"
mkdir -p "$tmp/workspace" "$tmp/data" "$tmp/state" "$tmp/cache" "$tmp/home/.config/opencode"
# Activate the real telemetry plugin, but keep its real hook client spool-only.
# This is the same private transport boundary used by the other CLI fixtures.
mkdir -p "$tmp/bin"
printf '#!/bin/sh\nunset LCARS_TELEMETRY_CREDENTIALS_FILE\nif [ "${1:-}" = hook ]; then\n  exec node %q "$@"\nfi\nexec node %q "$@"\n' "$lib_dir/lcars-hook.cjs" "$lib_dir/lcars-session-title.cjs" > "$tmp/bin/lcars"
chmod +x "$tmp/bin/lcars"
printf '{}\n' > "$tmp/not-a-credential.json"
# Exercise continuation from the baked empty schema, not a fresh migration.
# SQLite backup includes any checkpoint state without copying transient WALs.
mkdir -p "$tmp/data/opencode"
python3 - "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db" "$tmp/data/opencode/opencode.db" <<'PY_STORE'
import sqlite3
import sys
from pathlib import Path
with sqlite3.connect(Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True) as source:
    with sqlite3.connect(sys.argv[2]) as target:
        source.backup(target)
PY_STORE
printf '{}\n' > "$tmp/models.json"
# The production provider references a runtime-mounted secret that correctly
# does not exist while building the image. Keep the exact global instructions
# and plugins but remove that unrelated provider from the isolated test home.
jq 'del(.provider.homelab)' "$source_config_dir/opencode.json" > "$tmp/home/.config/opencode/opencode.json"
cp "$source_config_dir/instructions.md" \
  "$source_config_dir/context-lifecycle.js" \
  "$source_config_dir/lcars-session.js" \
  "$source_config_dir/lcars-telemetry.js" \
  "$tmp/home/.config/opencode/"
# Match the runner's configuration copy, including build-installed SDK deps.
# Missing preparation fails here rather than being repaired over the network.
cp -R "$source_config_dir/package.json" "$source_config_dir/package-lock.json" \
  "$source_config_dir/node_modules" "$tmp/home/.config/opencode/"
mkdir -p "$tmp/workspace/.claude/worktrees/task/app"
python3 - "$tmp/workspace" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
worktree = root / ".claude/worktrees/task"
# Same large root document under two distinct checkout paths reproduces the
# production instruction amplification; the child rule must remain present.
text = "ROOT_INSTRUCTION_SENTINEL\n" + ("Required root guidance. " * 2500) + "\n"
(root / "AGENTS.md").write_text(text)
(worktree / "AGENTS.md").write_text(text)
(worktree / "app/AGENTS.md").write_text("CHILD_INSTRUCTION_SENTINEL\n")
(worktree / "app/fixture.txt").write_text(
    "".join(f"LINE-{line:03d} " + ("x" * 120) + "\n" for line in range(1, 301)),
    encoding="utf-8",
)
PY

python3 "$here/opencode-continuation.test.py" "$tmp" &
server_pid=$!
# Python's http.server imports can exceed one second under arm64 emulation.
# Wait for the server's actual bound-port signal, while retaining a deadline
# and failing immediately if the fixture exits instead of becoming ready.
provider_start_deadline=$((SECONDS + provider_start_timeout_seconds))
while [ ! -s "$tmp/port" ]; do
  kill -0 "$server_pid" 2>/dev/null || fail "deterministic provider exited before becoming ready"
  [ "$SECONDS" -lt "$provider_start_deadline" ] ||
    fail "deterministic provider did not start within ${provider_start_timeout_seconds}s"
  sleep 0.1
done
port="$(cat "$tmp/port")"

cat > "$tmp/workspace/opencode.json" <<JSON
{
  "permission": {
    "read": "allow",
    "external_directory": "allow"
  },
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 500
  },
  "provider": {
    "continuation-contract": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local deterministic continuation contract",
      "options": {
        "baseURL": "http://127.0.0.1:$port/v1",
        "apiKey": "local-test-placeholder"
      },
      "models": {
        "test": {
          "name": "Local deterministic continuation contract",
          "limit": {
            "context": 4000,
            "input": 4000,
            "output": 8192
          }
        }
      }
    }
  }
}
JSON

framework_started_seconds=$SECONDS
framework_status=0
env -i \
  PATH="$tmp/bin:$PATH" \
  LCARS_RUN_ID=hook-test-run LCARS_REPO=hook-test/repo LCARS_ISSUE_NUMBER=7 \
  LCARS_TELEMETRY_CREDENTIALS_FILE="$tmp/not-a-credential.json" \
  OPENCODE_DISABLE_AUTOUPDATE=true \
  OPENCODE_DISABLE_MODELS_FETCH=true \
  OPENCODE_DISABLE_TERMINAL_TITLE=true \
  OPENCODE_MODELS_PATH="$tmp/models.json" \
  TMPDIR="$tmp" \
  HOME="$tmp/home" \
  XDG_CACHE_HOME="$tmp/cache" \
  XDG_CONFIG_HOME="$tmp/home/.config" \
  XDG_DATA_HOME="$tmp/data" \
  XDG_STATE_HOME="$tmp/state" \
  timeout -k 2s "${framework_timeout_seconds}s" "$opencode_bin" run \
  --model continuation-contract/test \
  --auto \
  --dir "$tmp/workspace" \
  "Read fixture.txt, preserve the task state, and continue after compaction." \
  >"$tmp/opencode.out" 2>&1 || framework_status=$?
printf '%s\n' "$framework_status" > "$tmp/opencode.exit"
echo "OpenCode continuation CLI: exit=$framework_status elapsed=$((SECONDS - framework_started_seconds))s deadline=${framework_timeout_seconds}s" >&2
if [ "$framework_status" -ne 0 ]; then
  tail -c 8192 "$tmp/opencode.out" >&2
  if [ -s "$tmp/observations.ndjson" ]; then
    cat "$tmp/observations.ndjson" >&2
  else
    echo "OpenCode continuation observations: 0 (startup did not reach localhost provider)" >&2
  fi
  fail "real OpenCode continuation run failed (exit $framework_status)" "$framework_status"
fi

python3 - "$tmp/observations.ndjson" "$tmp/data/opencode/opencode.db" <<'PY'
import json
import sqlite3
import sys
from pathlib import Path

observations = [
    json.loads(line)
    for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
]
working_index = next(
    index
    for index, item in enumerate(observations)
    if item["tools"] and not item["hasSummary"]
)
compaction_index = next(
    index
    for index, item in enumerate(observations)
    if index > working_index and item["isCompaction"]
)
continuation_index = next(
    index
    for index, item in enumerate(observations)
    if index > compaction_index
    and item["tools"]
    and item["hasSummary"]
    and item["toolMessageCount"] == 0
)
finished_index = next(
    index
    for index, item in enumerate(observations)
    if index > continuation_index
    and item["tools"]
    and item["hasSummary"]
    and item["toolMessageCount"] == 1
)
working = observations[working_index]
compaction = observations[compaction_index]
continuation = observations[continuation_index]
finished = observations[finished_index]
assert working["tools"] and working["hasStandingInstructions"], working
assert compaction["isCompaction"] and not compaction["tools"], compaction
assert continuation["tools"] and continuation["hasSummary"], continuation
assert continuation["hasSyntheticContinuation"], continuation
assert continuation["hasStandingInstructions"], continuation
assert finished["toolMessageCount"] == 1, finished
assert finished["toolHasLine120"] and finished["toolHasLine121"], finished
assert finished["toolHasLine200"], finished
assert compaction["maxTokens"] == 4096, compaction
for item in observations:
    if item["tools"]:
        assert item["rootInstructionCount"] == 1, item
        if item["toolMessageCount"]:
            assert item["hasChildInstructions"], item
# Request-local transformations must never erase archived instruction content.
with sqlite3.connect(f"file:{sys.argv[2]}?mode=ro", uri=True) as db:
    parts = [json.loads(row[0]) for row in db.execute("select data from part")]
reads = [part["state"] for part in parts
         if part.get("type") == "tool" and part.get("tool") == "read"
         and part.get("state", {}).get("status") == "completed"]
assert any("ROOT_INSTRUCTION_SENTINEL" in state["output"] for state in reads)
assert all(state["input"]["limit"] == 200 for state in reads)

PY

echo "OpenCode real-framework compaction and continuation contract: OK"

await_kinds "$tmp/home" opencode start stop
check_events "$tmp/home" opencode
