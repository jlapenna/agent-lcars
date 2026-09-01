#!/usr/bin/env bash
# Regression test for the patches/nx+23.1.2.patch fix (issue #942,
# sprinkles#4255): a transient network failure reading the self-hosted Nx
# remote cache must not crash an otherwise fully-green nx run. Runs the real
# installed (patched) nx binary against a scratch fixture workspace and a
# TCP server that accepts a connection then resets it mid-request -- what a
# reachable-but-flaky remote-cache server looks like, as opposed to a fully
# unreachable port (which Nx already tolerates).
#
# Invoked via a plain subshell, not Node's child_process: a `spawnSync`-based
# version of this same repro intermittently hung waiting on the process tree
# even after nx itself had finished and printed its summary -- a
# spawnSync/test-runner quirk unrelated to this fix. Dozens of plain-shell
# runs during development never hung.
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
NX_BIN="$REPO/node_modules/.bin/nx"
TEST_DIR="$(mktemp -d)"
FIXTURE="$TEST_DIR/fixture"
CACHE_DIR="$TEST_DIR/cache"
SERVER_LOG="$TEST_DIR/server.log"
SERVER_SCRIPT="$TEST_DIR/flaky-server.mjs"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT

mkdir -p "$FIXTURE/apps/a"
cat >"$FIXTURE/package.json" <<'EOF'
{"name":"fixture","version":"0.0.0","private":true,"workspaces":["apps/*"]}
EOF
cat >"$FIXTURE/nx.json" <<'EOF'
{"targetDefaults":{"echo":{"cache":true}}}
EOF
cat >"$FIXTURE/apps/a/project.json" <<'EOF'
{"name":"a","root":"apps/a","targets":{"echo":{"executor":"nx:run-commands","options":{"command":"echo hello-from-a"}}}}
EOF
echo '{"name":"a","version":"0.0.0"}' >"$FIXTURE/apps/a/package.json"

# Accepts a connection (so the initial TCP connect succeeds, matching a
# reachable-but-flaky server) then resets it instead of completing the
# request.
cat >"$SERVER_SCRIPT" <<'EOF'
import net from 'node:net';
const server = net.createServer((socket) => {
  socket.on('data', () => socket.destroy());
  setTimeout(() => socket.destroy(), 200);
});
server.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`));
EOF

node "$SERVER_SCRIPT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  [ -s "$SERVER_LOG" ] && break
  sleep 0.1
done
PORT="$(sed -n 's/^PORT=//p' "$SERVER_LOG")"
[ -n "$PORT" ]

RUN_LOG="$TEST_DIR/run.log"
set +e
(
  cd "$FIXTURE"
  env -i PATH="$PATH" HOME="$HOME" \
    NX_CACHE_DIRECTORY="$CACHE_DIR" \
    NX_DAEMON=false \
    NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:$PORT" \
    NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=dummy-token \
    "$NX_BIN" run-many -t echo --outputStyle=stream
) >"$RUN_LOG" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "expected nx to exit 0 despite the cache blip, got $status:" >&2
  cat "$RUN_LOG" >&2
  exit 1
fi

grep -q 'Successfully ran target echo' "$RUN_LOG"
grep -Eq 'Failed to (read|write) remote cache entry' "$RUN_LOG" || {
  echo "expected the patched warning to fire, proving the failure genuinely happened and was tolerated:" >&2
  cat "$RUN_LOG" >&2
  exit 1
}

echo "ok: remote-cache read failure did not crash an otherwise-green nx run"
