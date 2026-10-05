#!/usr/bin/env bash
# Build gate for the baked OpenCode store (#2040, #2071), run in the layer
# after prepare-opencode-store.sh so the store is a cold lower-layer file.
#
# Locking boundary: OpenCode v1.18.25 opens SQLite and executes
# `PRAGMA journal_mode = WAL` before it sets `busy_timeout`, so that first
# statement fails immediately with `database is locked` on any contention.
# When no other connection holds the store, two OpenCode processes contend:
# the last connection to close takes an EXCLUSIVE lock to checkpoint and
# delete the WAL, and the first opener initializes the WAL index. Racing two
# bare `session list` processes is therefore a timing lottery, which emulated
# arm64 loses often enough to block publication. It is not an overlayfs
# copy-up effect; a plain filesystem reproduces it.
#
# Runtime readers coexist with a long-lived `opencode run` connection. Model
# that: one OpenCode reader opens the cold store alone (copy-up and WAL-index
# initialization by the real CLI), then a held SQLite connection keeps the
# store open while concurrent OpenCode readers start together. Every reader
# must succeed; there is no retry.
set -euo pipefail
opencode_bin="${OPENCODE_BIN:-/usr/local/bin/opencode}"
store_check="${OPENCODE_STORE_CHECK:-/usr/local/lib/agent-lcars/check-opencode-store.sh}"
store="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
db="$store/opencode.db"
readers=3
ready_timeout_seconds=120

fail() {
  echo "check-opencode-concurrent-readers: $*" >&2
  exit 1
}

scratch="$(mktemp -d)"
holder_pid=''
cleanup() {
  if [ -n "$holder_pid" ]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

# --pure still resolves global config file references, including the
# production API-key mount that is absent during a build.
export XDG_CONFIG_HOME="$scratch/config"
unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_DIR
export OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_DISABLE_MODELS_FETCH=true

[ -f "$db" ] || fail "baked store is missing: $db"

assert_empty_listing() {
  # The pinned CLI emits no bytes for an empty result.
  if [ -s "$1" ]; then
    jq -e 'type == "array" and length == 0' "$1" >/dev/null ||
      fail "reader returned sessions or malformed output: $1"
  fi
}

"$opencode_bin" --pure session list --format json >"$scratch/cold.json" ||
  fail 'cold OpenCode reader failed against the baked store'
assert_empty_listing "$scratch/cold.json"

# The holder reads its program from -c: its stdin is the coproc pipe, and
# closing that pipe is what releases the store.
holder_program="
import sqlite3
import sys
db = sqlite3.connect(sys.argv[1], timeout=60, isolation_level=None)
if db.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
    raise SystemExit('baked OpenCode store is not in WAL mode')
if db.execute('SELECT count(*) FROM session').fetchone()[0] != 0:
    raise SystemExit('baked OpenCode store must contain no sessions')
print('ready', flush=True)
sys.stdin.read()
db.close()
"
coproc HOLDER { exec python3 -c "$holder_program" "$db"; }
holder_pid="$HOLDER_PID"
holder_out="${HOLDER[0]}"
holder_in="${HOLDER[1]}"
read -r -t "$ready_timeout_seconds" -u "$holder_out" holder_state ||
  fail 'store holder did not become ready'
[ "$holder_state" = ready ] || fail "unexpected store holder state: $holder_state"

pids=()
for reader in $(seq "$readers"); do
  "$opencode_bin" --pure session list --format json >"$scratch/reader-$reader.json" &
  pids+=("$!")
done
failed=0
for reader in $(seq "$readers"); do
  if ! wait "${pids[$((reader - 1))]}"; then
    echo "check-opencode-concurrent-readers: concurrent reader $reader failed" >&2
    failed=1
  fi
done
[ "$failed" -eq 0 ] || fail 'concurrent OpenCode readers did not all succeed'
for reader in $(seq "$readers"); do
  assert_empty_listing "$scratch/reader-$reader.json"
done

exec {holder_in}>&-
wait "$holder_pid" || fail 'store holder did not close cleanly'
holder_pid=''

python3 - "$db" <<'PY'
import sqlite3
import sys
db = sqlite3.connect(sys.argv[1], isolation_level=None)
try:
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise SystemExit('OpenCode store integrity check failed')
finally:
    db.close()
PY
bash "$store_check"
