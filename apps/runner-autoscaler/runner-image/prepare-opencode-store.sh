#!/usr/bin/env bash
# Bake only an empty, migrated store as the runner user. Never copy a developer's
# sessions/authentication into an image. The direct-runner fallback stays active
# until the published image passes its runtime copy-up verification (#2040).
set -euo pipefail
opencode_bin="${OPENCODE_BIN:-/usr/local/bin/opencode}"
version_file="${OPENCODE_VERSION_FILE:-/usr/local/share/agent-lcars-tooling/opencode-version}"
store="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
expected="$(tr -d '\r\n' < "$version_file")"
actual="$("$opencode_bin" --version)"
[ "$actual" = "${expected#v}" ] || { echo 'OpenCode binary does not match the image pin' >&2; exit 1; }
# Idempotent only for an empty store. Refuse to sanitize real session history.
listing="$(mktemp)"
trap 'rm -f "$listing"' EXIT
OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_DISABLE_MODELS_FETCH=true \
  "$opencode_bin" --pure session list --format json >"$listing"
# The pinned CLI emits no bytes for an empty result; SQLite below remains
# authoritative even in that case (matching the existing runtime fallback).
if [ -s "$listing" ]; then
  jq -e 'type == "array" and length == 0' "$listing" >/dev/null
fi
python3 - "$store/opencode.db" <<'PY'
import sqlite3
import sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit('OpenCode did not create the expected runner store')
with sqlite3.connect(path) as db:
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise SystemExit('OpenCode store integrity check failed')
    if db.execute('SELECT count(*) FROM session').fetchone()[0] != 0:
        raise SystemExit('Refusing to bake nonempty OpenCode session history')
    for table in ('credential', 'account', 'control_account'):
        if db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]:
            raise SystemExit('Refusing to bake OpenCode authentication')
    busy, _, _ = db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
    if busy:
        raise SystemExit('OpenCode store checkpoint is busy')
PY
printf '%s\n' "$actual" >"$store/.lcars-baked-version"
