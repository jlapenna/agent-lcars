#!/usr/bin/env bash
# Artifact-boundary contract for the pinned OpenCode CLI, global standing
# instructions, context lifecycle hooks, automatic compaction, and continuation.
# It proves framework delivery and hook execution, not model obedience.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
opencode_bin="${OPENCODE_BIN:-/usr/local/bin/opencode}"
expected_version="$(tr -d '\r\n' < "$here/opencode-version")"
expected_version="${expected_version#v}"
framework_timeout_seconds=60
version_timeout_seconds=10
# The multi-platform publisher executes the arm64 CLI through QEMU on its
# amd64 BuildKit host. The same deterministic framework sequence takes more
# than the native deadline there, before the localhost provider sees a first
# request. This remains a test-process bound; provider and runner limits are
# unchanged.
case "$(uname -m)" in
  aarch64 | arm64)
    version_timeout_seconds=60
    framework_timeout_seconds=180
    ;;
esac

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test -x "$opencode_bin" || fail "OpenCode executable is unavailable at $opencode_bin"
actual_version="$(timeout -k 2s "${version_timeout_seconds}s" "$opencode_bin" --version)" ||
  fail "pinned OpenCode version probe did not complete"
[ "$actual_version" = "$expected_version" ] ||
  fail "test must run against pinned OpenCode $expected_version"

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

source_config_dir="$HOME/.config/opencode"
test -f "$source_config_dir/opencode.json" || fail "runner-global OpenCode config is missing"
mkdir -p "$tmp/workspace" "$tmp/data" "$tmp/state" "$tmp/cache" "$tmp/home/.config/opencode"
printf '{}\n' > "$tmp/models.json"
# The production provider references a runtime-mounted secret that correctly
# does not exist while building the image. Keep the exact global instructions
# and plugins but remove that unrelated provider from the isolated test home.
jq 'del(.provider.homelab)' "$source_config_dir/opencode.json" > "$tmp/home/.config/opencode/opencode.json"
cp "$source_config_dir/instructions.md" \
  "$source_config_dir/context-lifecycle.js" \
  "$source_config_dir/lcars-session.js" \
  "$tmp/home/.config/opencode/"
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
for _ in $(seq 1 50); do
  [ -s "$tmp/port" ] && break
  sleep 0.02
done
[ -s "$tmp/port" ] || fail "deterministic provider did not start"
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

env \
  -u OPENCODE_CONFIG \
  -u OPENCODE_CONFIG_CONTENT \
  -u OPENCODE_CONFIG_DIR \
  -u OPENCODE_LLM_API_KEY \
  OPENCODE_DISABLE_AUTOUPDATE=true \
  OPENCODE_DISABLE_MODELS_FETCH=true \
  OPENCODE_DISABLE_TERMINAL_TITLE=true \
  OPENCODE_MODELS_PATH="$tmp/models.json" \
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
  >"$tmp/opencode.stdout" 2>"$tmp/opencode.stderr" || {
    cat "$tmp/opencode.stderr" >&2
    if [ -s "$tmp/observations.ndjson" ]; then
      cat "$tmp/observations.ndjson" >&2
    else
      echo "OpenCode continuation observations: 0 (startup did not reach localhost provider)" >&2
    fi
    fail "real OpenCode continuation run failed"
  }

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
