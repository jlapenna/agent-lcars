#!/usr/bin/env bash
# Artifact-boundary contract for the pinned OpenCode CLI, global standing
# instructions, bounded-read hook, automatic compaction, and continuation.
# It proves framework delivery and hook execution, not model obedience.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
opencode_bin="${OPENCODE_BIN:-/usr/local/bin/opencode}"
expected_version="$(tr -d '\r\n' < "$here/opencode-version")"
expected_version="${expected_version#v}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test -x "$opencode_bin" || fail "OpenCode executable is unavailable at $opencode_bin"
[ "$("$opencode_bin" --version)" = "$expected_version" ] ||
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
  "$source_config_dir/bounded-read.js" \
  "$source_config_dir/lcars-session.js" \
  "$tmp/home/.config/opencode/"
python3 - "$tmp/workspace/fixture.txt" <<'PY'
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    "".join(f"LINE-{line:03d} " + ("x" * 120) + "\n" for line in range(1, 201)),
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
            "output": 500
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
  timeout -k 2s 60s "$opencode_bin" run \
  --model continuation-contract/test \
  --auto \
  --dir "$tmp/workspace" \
  "Read fixture.txt, preserve the task state, and continue after compaction." \
  >"$tmp/opencode.stdout" 2>"$tmp/opencode.stderr" || {
    cat "$tmp/opencode.stderr" >&2
    cat "$tmp/observations.ndjson" >&2 2>/dev/null || true
    fail "real OpenCode continuation run failed"
  }

python3 - "$tmp/observations.ndjson" <<'PY'
import json
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
assert finished["toolHasLine120"] and not finished["toolHasLine121"], finished
PY

echo "OpenCode real-framework compaction and continuation contract: OK"
