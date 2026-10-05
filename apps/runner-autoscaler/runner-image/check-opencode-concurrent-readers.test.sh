#!/usr/bin/env bash
# Exercises check-opencode-concurrent-readers.sh with a fake CLI that opens
# SQLite exactly as OpenCode v1.18.25 does: its first statement runs with no
# busy timeout (#2071). The fake proves the gate's ordering deterministically
# through the store's POSIX locks instead of hoping a race does not fire: the
# cold reader is the only connection, and every concurrent reader starts
# together while another process already holds the store open.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "check-opencode-concurrent-readers.test.sh: $*" >&2
  exit 1
}

cat > "$tmp/opencode" <<'PY'
#!/usr/bin/env python3
import fcntl
import json
import os
import sqlite3
import struct
import sys
import time

assert sys.argv[1:] == ['--pure', 'session', 'list', '--format', 'json'], sys.argv
assert os.environ['XDG_CONFIG_HOME'] != os.environ['REAL_CONFIG_HOME']
state = os.environ['FAKE_STATE']
path = os.path.join(os.environ['XDG_DATA_HOME'], 'opencode', 'opencode.db')

def held_by_another_process():
    # An open WAL-mode SQLite connection keeps a read lock on SHARED_FIRST.
    fd = os.open(path, os.O_RDONLY)
    try:
        probe = struct.pack('hhqqi', fcntl.F_WRLCK, os.SEEK_SET, 0x40000002, 510, 0)
        return struct.unpack('hhqqi', fcntl.fcntl(fd, fcntl.F_GETLK, probe))[0] != fcntl.F_UNLCK
    finally:
        os.close(fd)

with open(os.path.join(state, 'counter'), 'a+') as counter:
    fcntl.flock(counter, fcntl.LOCK_EX)
    counter.seek(0)
    ordinal = len(counter.read().splitlines()) + 1
    held = held_by_another_process()
    counter.write(f'{ordinal}\n')

log = open(os.path.join(state, 'log'), 'a')
if ordinal == 1:
    log.write(f'cold held={held}\n')
else:
    # Wait until every concurrent reader has started before any opens, so
    # `held` above can only observe a connection outside the reader set.
    expected = int(os.environ['FAKE_CONCURRENT_READERS']) + 1
    deadline = time.monotonic() + 30
    while True:
        with open(os.path.join(state, 'counter')) as counter:
            if len(counter.read().splitlines()) >= expected:
                break
        if time.monotonic() > deadline:
            log.write(f'reader {ordinal} started alone\n')
            sys.exit(1)
        time.sleep(0.01)
    log.write(f'concurrent held={held}\n')
log.flush()
if os.environ.get('FAKE_FAIL_ORDINAL') == str(ordinal):
    print('Error: database is locked', file=sys.stderr)
    sys.exit(1)

db = sqlite3.connect(path, timeout=0, isolation_level=None)
db.execute('PRAGMA journal_mode = WAL')
db.execute('PRAGMA busy_timeout = 5000')
sessions = [row[0] for row in db.execute('SELECT id FROM session')]
db.close()
if sessions:
    print(json.dumps([{'id': session} for session in sessions]))
PY
chmod +x "$tmp/opencode"

make_store() {
  local name="$1"
  local data="$tmp/$name/data"
  mkdir -p "$data/opencode" "$tmp/$name/state"
  python3 - "$data/opencode/opencode.db" <<'PY'
import sqlite3
import sys
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute('PRAGMA journal_mode = WAL')
db.execute('CREATE TABLE session (id TEXT)')
db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
db.close()
PY
  printf '1.18.25\n' > "$data/opencode/.lcars-baked-version"
}

run_gate() {
  local name="$1"
  shift
  env XDG_DATA_HOME="$tmp/$name/data" \
    XDG_CONFIG_HOME="$tmp/real-config" REAL_CONFIG_HOME="$tmp/real-config" \
    OPENCODE_BIN="$tmp/opencode" \
    OPENCODE_STORE_CHECK="$here/check-opencode-store.sh" \
    OPENCODE_VERSION_FILE="$here/opencode-version" \
    FAKE_STATE="$tmp/$name/state" FAKE_CONCURRENT_READERS=3 "$@" \
    bash "$here/check-opencode-concurrent-readers.sh" >"$tmp/$name/out" 2>&1
}

[ "$(tr -d '\r\n' < "$here/opencode-version")" = v1.18.25 ] ||
  fail 'update the baked-version fixture alongside the pinned OpenCode version'

make_store healthy
run_gate healthy || {
  cat "$tmp/healthy/out" >&2
  fail 'healthy baked store did not pass'
}
expected_log=$'cold held=False\nconcurrent held=True\nconcurrent held=True\nconcurrent held=True'
[ "$(cat "$tmp/healthy/state/log")" = "$expected_log" ] ||
  fail "unexpected reader ordering: $(cat "$tmp/healthy/state/log")"

make_store failing-reader
if run_gate failing-reader FAKE_FAIL_ORDINAL=3; then
  fail 'a failed concurrent reader was not fatal'
fi
grep -Eq 'concurrent reader [1-3] failed' "$tmp/failing-reader/out" ||
  fail 'failed concurrent reader was not identified'

make_store failing-cold
if run_gate failing-cold FAKE_FAIL_ORDINAL=1; then
  fail 'a failed cold reader was not fatal'
fi

make_store nonempty
python3 -c 'import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); db.execute("INSERT INTO session VALUES (1)"); db.commit()' \
  "$tmp/nonempty/data/opencode/opencode.db"
if run_gate nonempty; then
  fail 'a store with session history passed'
fi

make_store stale-version
printf '1.18.24\n' > "$tmp/stale-version/data/opencode/.lcars-baked-version"
if run_gate stale-version; then
  fail 'a store baked by another OpenCode version passed'
fi

mkdir -p "$tmp/missing/data" "$tmp/missing/state"
if run_gate missing; then
  fail 'a missing store passed'
fi
grep -Fq 'baked store is missing' "$tmp/missing/out" || fail 'missing store was not reported'

echo 'check-opencode-concurrent-readers.test.sh: PASS'
