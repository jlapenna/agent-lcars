#!/usr/bin/env bash
# Offline contract: the image's real Claude Code, Codex and OpenCode CLIs run
# the hook telemetry this image installs, and each session reaches the local
# spool as SessionEventV1 events stamped with the dispatched run. Claude Code
# and Codex are installed unpinned, so a CLI release that renames a hook,
# changes its payload or stops running it must fail publication here instead
# of silently dropping live sessions (docs/hooks-telemetry-design.md).
#
# A localhost provider answers Claude/Codex requests with "ok"; nothing leaves
# the container. No writer is configured for Claude Code and Codex, so the
# flusher leaves their events in the spool. OpenCode's continuation fixture
# finishes this gate with the same real telemetry assertions, using one framework
# run for both compaction/continuation and telemetry instead of two cold starts.
set -euo pipefail

lib_dir="${HOOK_TEST_LIB_DIR:-/usr/local/lib/agent-lcars}"
claude_bin="${CLAUDE_BIN:-$(command -v claude)}"
codex_bin="${CODEX_BIN:-$(command -v codex)}"
run_timeout_seconds=60
event_timeout_seconds=30
# Claude Code gives SessionEnd hooks 1.5s by default. The arm64 image is
# built under QEMU, where starting node alone can exceed that. Widen it on
# arm64 (native arm64 runners only get a looser bound) so the contract under
# test stays "the hook runs and records the end", not emulator speed.
claude_end_budget=()
fixture_hook_timeout_seconds=0
case "$(uname -m)" in
  aarch64 | arm64)
    run_timeout_seconds=180
    event_timeout_seconds=90
    fixture_hook_timeout_seconds=30
    claude_end_budget=(CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=30000)
    ;;
esac

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  drained=true
  # CLI exit and spooled events do not mean its detached hook clients exited.
  # Drain only this test's unique TMPDIR before deleting files they still use.
  if ! python3 "$(dirname "${BASH_SOURCE[0]}")/drain-hook-test-clients.py" "$tmp"; then
    drained=false
  fi
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "$drained" != true ]; then
    return 1
  fi
  rm -rf "$tmp"
}
trap 'cleanup && { if [ -n "${HOOK_TEST_LIB_DIR:-}" ]; then
  printf "drained\n" > "$lib_dir/.hook-smoke-drained"
fi; }' EXIT

# The hook stubs run `lcars` from PATH; point it at this image's bundle.
mkdir -p "$tmp/bin" "$tmp/work"
printf '#!/bin/sh\nunset LCARS_TELEMETRY_CREDENTIALS_FILE\nif [ "${1:-}" = hook ]; then\n  exec node %q "$@"\nfi\nexec node %q "$@"\n' "$lib_dir/lcars-hook.cjs" "$lib_dir/lcars-session-title.cjs" > "$tmp/bin/lcars"
chmod +x "$tmp/bin/lcars"

cat > "$tmp/provider.mjs" <<'JS'
import fs from 'node:fs';
import http from 'node:http';
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  res.end();
};
const usage = { input_tokens: 1, output_tokens: 1 };
let lifecycleRecords = 0;
const record = (value) => {
  if (lifecycleRecords++ < 64) fs.appendFileSync(process.argv[3], JSON.stringify(value) + '\n');
};
const server = http.createServer((req, res) => {
  // Only the mock provider's lifecycle is diagnostic: never retain headers,
  // model inputs, outputs, or arbitrary request URLs.
  const route = ['/v1/messages', '/v1/responses']
    .find((path) => req.url.startsWith(path)) ?? 'unknown';
  record({ route, stage: 'request' });
  res.on('finish', () => record({ route, stage: 'response', status: res.statusCode, completed: true }));
  res.on('close', () => record({ route, stage: 'closed', completed: res.writableFinished }));
  req.resume();
  req.on('end', () => {
    if (req.url.startsWith('/v1/messages')) {
      const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, usage };
      return sse(res, [
        ['message_start', { type: 'message_start', message }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    }
    if (req.url.startsWith('/v1/responses')) {
      const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
      const response = { id: 'resp_1', object: 'response', status: 'completed', model: 'test', output: [item], usage: { ...usage, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      return sse(res, [
        ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response }],
      ]);
    }
    res.writeHead(404);
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(server.address().port)));
JS
node "$tmp/provider.mjs" "$tmp/port" "$tmp/provider-lifecycle.ndjson" &
server_pid=$!
deadline=$((SECONDS + 30))
while [ ! -s "$tmp/port" ]; do
  kill -0 "$server_pid" 2>/dev/null || fail "localhost provider exited before becoming ready"
  [ "$SECONDS" -lt "$deadline" ] || fail "localhost provider did not start"
  sleep 0.1
done
base_url="http://127.0.0.1:$(cat "$tmp/port")/v1"

# Every runtime gets its own clean home, so each spool holds one session.
run_env() {
  local home="$1"
  shift
  env -i PATH="$tmp/bin:$PATH" HOME="$home" TMPDIR="$tmp" \
    LCARS_RUN_ID=hook-test-run LCARS_REPO=hook-test/repo LCARS_ISSUE_NUMBER=7 \
    "$@"
}

source "$(dirname "${BASH_SOURCE[0]}")/hook-telemetry-assertions.sh"

# --- Claude Code ------------------------------------------------------------
claude_home="$tmp/claude-home"
mkdir -p "$claude_home"
run_env "$claude_home" lcars integration install claude > /dev/null ||
  fail "lcars integration install claude failed"
# A marker hook beside ours tells "Claude Code skipped SessionEnd hooks"
# apart from "our end hook failed". `claude -p` skips them entirely when it
# exits with an async Stop hook still running, which on a 2-CPU runner was
# every run until our Stop entry became synchronous.
jq --arg marker "$tmp/claude-session-end-ran" \
  --argjson timeout "$fixture_hook_timeout_seconds" \
  'if $timeout > 0 then
    # The CLI-wide SessionEnd budget does not replace per-command deadlines.
    # Keep production settings unchanged; this private fixture runs under QEMU.
    .hooks |= with_entries(.value |= map(.hooks |= map(
      if .type == "command" and .async != true then .timeout = $timeout else . end
    )))
  else . end
  | .hooks.SessionEnd += [{ hooks: [{ type: "command", command: "touch \($marker)" }] }]' \
  "$claude_home/.claude/settings.json" > "$tmp/settings.json"
mv "$tmp/settings.json" "$claude_home/.claude/settings.json"
(
  cd "$tmp/work"
  run_env "$claude_home" ANTHROPIC_BASE_URL="${base_url%/v1}" ANTHROPIC_API_KEY=hook-test \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "${claude_end_budget[@]}" \
    timeout -k 2s "${run_timeout_seconds}s" "$claude_bin" -p "say ok" < /dev/null
) > "$tmp/claude.out" 2>&1 || {
  status=$?
  cat "$tmp/claude.out" >&2
  fail "claude -p exited $status against the localhost provider"
}
printf '0\n' > "$tmp/claude-code.exit"
[ -e "$tmp/claude-session-end-ran" ] ||
  fail "claude -p ran no SessionEnd hooks (an async hook still running at exit?)"
await_kinds "$claude_home" claude-code start stop end
check_events "$claude_home" claude-code

# --- Codex ------------------------------------------------------------------
codex_home="$tmp/codex-home"
mkdir -p "$codex_home/.codex"
cat > "$codex_home/.codex/config.toml" <<TOML
model = "test"
model_provider = "hook-test"
[model_providers.hook-test]
name = "hook-test"
base_url = "$base_url"
wire_api = "responses"
env_key = "HOOK_TEST_KEY"
TOML
run_env "$codex_home" lcars integration install codex > /dev/null ||
  fail "lcars integration install codex failed"
# Match the existing ARM fixture allowance for synchronous Claude hooks.
# Only this private Stop command changes; production stays at 5 s, AMD64
# fixture runs keep 5 s, and SessionEnd retains its 3 s detached handoff.
if [ "$fixture_hook_timeout_seconds" -gt 0 ]; then
  jq --argjson timeout "$fixture_hook_timeout_seconds" \
    '.hooks.Stop |= map(.hooks |= map(
      if .type == "command" and .async != true then .timeout = $timeout else . end
    ))' "$codex_home/.codex/hooks.json" > "$tmp/codex-hooks.json"
  mv "$tmp/codex-hooks.json" "$codex_home/.codex/hooks.json"
fi
# Same flags hook-telemetry-bootstrap.sh passes on a dispatched runner.
(
  cd "$tmp/work"
  run_env "$codex_home" HOOK_TEST_KEY=hook-test \
    timeout -k 2s "${run_timeout_seconds}s" "$codex_bin" exec \
    --enable hooks --dangerously-bypass-hook-trust --skip-git-repo-check "say ok" < /dev/null
) > "$tmp/codex.out" 2>&1 || {
  status=$?
  cat "$tmp/codex.out" >&2
  fail "codex exec exited $status against the localhost provider"
}
printf '0\n' > "$tmp/codex.exit"
# Codex kills a SessionEnd hook at 3 s, so the stub hands the end to a
# detached client (integration.ts, #2827); this waits for that client.
await_kinds "$codex_home" codex start stop end
check_events "$codex_home" codex
# The client releases the payload the runner drain waits on once spooled.
inflight="$codex_home/.local/state/agent-lcars/hook-inflight"
deadline=$((SECONDS + event_timeout_seconds))
while compgen -G "$inflight/*" > /dev/null; do
  [ "$SECONDS" -lt "$deadline" ] || fail "codex SessionEnd client left its payload in $inflight"
  sleep 0.5
done

# The continuation fixture owns OpenCode's real framework run and telemetry
# assertions together. Retire these clients before transferring cleanup ownership;
# a refused OpenCode drain must not acknowledge safe removal of shared bundles.
cleanup
trap - EXIT
exec bash "$(dirname "${BASH_SOURCE[0]}")/opencode-continuation.test.sh"
