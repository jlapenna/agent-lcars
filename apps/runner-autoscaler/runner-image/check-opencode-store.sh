#!/usr/bin/env bash
# Cheap build/runtime invariant: version metadata and a readable empty schema.
# Runtime falls back to synchronous migration when this assertion does not hold.
set -euo pipefail
runner_home="${AGENT_LCARS_RUNNER_HOME:-$HOME}"
version_file="${OPENCODE_VERSION_FILE:-/usr/local/share/agent-lcars-tooling/opencode-version}"
store="${XDG_DATA_HOME:-$runner_home/.local/share}/opencode"
expected="$(tr -d '\r\n' < "$version_file")"
[ "$(cat "$store/.lcars-baked-version")" = "${expected#v}" ]
python3 - "$store/opencode.db" <<'PY'
import sqlite3
import sys
from pathlib import Path
path = Path(sys.argv[1])
with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
    if db.execute('SELECT count(*) FROM session').fetchone()[0] != 0:
        raise SystemExit('Baked OpenCode store must contain no sessions')
PY
