#!/usr/bin/env bash
# Shared spool assertions for the real CLI fixtures; caller owns tmp and event_timeout_seconds.
# Events from the spool, including any a failed flush moved to pending.
spooled() {
  local spool="$1/.local/state/agent-lcars/spool"
  cat "$spool/events.pending.ndjson" "$spool/events.ndjson" 2>/dev/null || true
}

# Print only bounded metadata from files this smoke owns. CLI output includes
# model text even against the mock provider, so raw output is never published.
failure_diagnostics() {
  local agent="$1"
  node - "$tmp" "$agent" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const [root, agent] = process.argv.slice(2);
const read = (name) => {
  try {
    const fd = fs.openSync(path.join(root, name), 'r');
    try {
      const bytes = Buffer.alloc(65536);
      const size = fs.fstatSync(fd).size;
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      return { size, text: bytes.subarray(0, length).toString('utf8') };
    } finally { fs.closeSync(fd); }
  } catch { return { size: 0, text: '' }; }
};
const output = read(`${agent === 'claude-code' ? 'claude' : agent}.out`);
const cli = read(`${agent}.exit`);
const provider = read('provider-lifecycle.ndjson');
const counts = { error: 0, warning: 0, timeout: 0, connection: 0 };
for (const line of output.text.split('\n')) {
  for (const key of Object.keys(counts)) {
    if (new RegExp(`\\b${key === 'warning' ? 'warn(?:ing)?' : key}\\b`, 'i').test(line)) counts[key]++;
  }
}
console.error('hook smoke lifecycle: ' + JSON.stringify({
  agent, cliExit: /^\d+\s*$/.test(cli.text) ? Number(cli.text) : null,
  outputBytes: output.size, inspectedBytes: Math.min(output.size, 65536),
  outputCategories: counts,
  provider: provider.text.trim().split('\n').filter(Boolean).slice(-64).map((line) => {
    try { return JSON.parse(line); } catch { return { malformed: true }; }
  }),
}));
JS
}

# Background hooks finish after their CLI exits; wait for the expected kinds.
await_kinds() {
  local home="$1" agent="$2"
  shift 2
  local deadline=$((SECONDS + event_timeout_seconds)) kind missing
  while :; do
    missing=""
    for kind in "$@"; do
      spooled "$home" | jq -se --arg k "$kind" 'any(.[]; .kind == $k)' > /dev/null || missing="$missing $kind"
    done
    [ -z "$missing" ] && return 0
    if [ "$SECONDS" -ge "$deadline" ]; then
      failure_diagnostics "$agent"
      echo "$agent spool:" >&2
      spooled "$home" >&2
      cat "$home/.local/state/agent-lcars/hook.log" >&2 2>/dev/null || true
      fail "$agent session is missing hook events:$missing"
    fi
    sleep 0.5
  done
}

# Each event names the agent and the dispatched run, and carries a summary.
check_events() {
  local home="$1" agent="$2"
  spooled "$home" | jq -se --arg agent "$agent" '
    length > 0 and all(.[];
      .version == 1 and .agent == $agent and .summary.sessionId == .sessionId
      and .runner.runId == "hook-test-run" and .runner.issueNumber == 7
      and .runner.repo == { owner: "hook-test", name: "repo" })
    and ([.[].sessionId] | unique | length) == 1
  ' > /dev/null || {
    spooled "$home" >&2
    fail "$agent hook events do not describe the dispatched session"
  }
  echo "ok: $agent $(spooled "$home" | jq -sr 'map(.kind) | join(",")')"
}
