#!/usr/bin/env bash
# Offline contract: the image's real Claude Code, Codex and OpenCode CLIs run
# the hook telemetry this image installs, and each session reaches the local
# spool as SessionEventV1 events stamped with the dispatched run. Claude Code
# and Codex are installed unpinned, so a CLI release that renames a hook,
# changes its payload or stops running it must fail publication here instead
# of silently dropping live sessions (docs/hooks-telemetry-design.md).
#
# A localhost provider answers every model request with "ok"; nothing leaves
# the container. No writer is configured for Claude Code and Codex, so the
# flusher leaves their events in the spool. OpenCode's plugin only reports
# once LCARS_TELEMETRY_CREDENTIALS_FILE is set; the placeholder file it names
# is not a credential, so its flushes fail and the events stay spooled too.
set -euo pipefail

lib_dir="${HOOK_TEST_LIB_DIR:-/usr/local/lib/agent-lcars}"
claude_bin="${CLAUDE_BIN:-$(command -v claude)}"
codex_bin="${CODEX_BIN:-$(command -v codex)}"
opencode_bin="${OPENCODE_BIN:-/usr/local/bin/opencode}"
opencode_config_dir="${HOOK_TEST_OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
run_timeout_seconds=60
# Claude Code gives SessionEnd hooks 1.5s by default. The arm64 image is
# built under QEMU, where starting node alone can exceed that; a native arm64
# runner does not. Widen it only for the emulated build so the contract under
# test stays "the hook runs and records the end", not emulator speed.
claude_end_budget=()
case "$(uname -m)" in
  aarch64 | arm64)
    run_timeout_seconds=180
    claude_end_budget=(CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=15000)
    ;;
esac

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

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

# The hook stubs run `lcars` from PATH; point it at this image's bundle.
mkdir -p "$tmp/bin" "$tmp/work"
printf '#!/bin/sh\nexec node %q "$@"\n' "$lib_dir/lcars-session-title.cjs" > "$tmp/bin/lcars"
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
const server = http.createServer((req, res) => {
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
    if (req.url.startsWith('/v1/chat/completions')) {
      const chunk = { id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test' };
      return sse(res, [
        [null, { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }],
        [null, { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }],
        [null, '[DONE]'],
      ]);
    }
    res.writeHead(404);
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(server.address().port)));
JS
node "$tmp/provider.mjs" "$tmp/port" &
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

# Events from the spool, including any a failed flush moved to pending.
spooled() {
  local spool="$1/.local/state/agent-lcars/spool"
  cat "$spool/events.pending.ndjson" "$spool/events.ndjson" 2>/dev/null || true
}

# Background hooks finish after their CLI exits; wait for the expected kinds.
await_kinds() {
  local home="$1" agent="$2"
  shift 2
  local deadline=$((SECONDS + 30)) kind missing
  while :; do
    missing=""
    for kind in "$@"; do
      spooled "$home" | jq -e --arg k "$kind" 'select(.kind == $k)' > /dev/null || missing="$missing $kind"
    done
    [ -z "$missing" ] && return 0
    if [ "$SECONDS" -ge "$deadline" ]; then
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

# --- Claude Code ------------------------------------------------------------
# Claude Code 2.1 sometimes exits print mode without running SessionEnd hooks
# at all. A marker hook beside ours shows whether it ran, and a run that
# skipped it is retried in a fresh home, so the end event (the part this
# image controls) is checked on nearly every build.
claude_attempt() {
  local home="$1" marker="$2"
  mkdir -p "$home"
  run_env "$home" lcars integration install claude > /dev/null ||
    fail "lcars integration install claude failed"
  jq --arg marker "$marker" \
    '.hooks.SessionEnd += [{ hooks: [{ type: "command", command: "touch \($marker)" }] }]' \
    "$home/.claude/settings.json" > "$tmp/settings.json"
  mv "$tmp/settings.json" "$home/.claude/settings.json"
  (
    cd "$tmp/work"
    run_env "$home" ANTHROPIC_BASE_URL="${base_url%/v1}" ANTHROPIC_API_KEY=hook-test \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "${claude_end_budget[@]}" \
      timeout -k 2s "${run_timeout_seconds}s" "$claude_bin" -p "say ok" < /dev/null
  ) > "$tmp/claude.out" 2>&1 || {
    status=$?
    cat "$tmp/claude.out" >&2
    fail "claude -p exited $status against the localhost provider"
  }
}
for attempt in 1 2 3; do
  claude_home="$tmp/claude-home-$attempt"
  claude_attempt "$claude_home" "$tmp/claude-session-end-$attempt"
  [ -e "$tmp/claude-session-end-$attempt" ] && break
  echo "note: claude ran no SessionEnd hooks on attempt $attempt"
done
if [ -e "$tmp/claude-session-end-$attempt" ]; then
  await_kinds "$claude_home" claude-code start end
else
  await_kinds "$claude_home" claude-code start
fi
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
await_kinds "$codex_home" codex start end
check_events "$codex_home" codex

# --- OpenCode ---------------------------------------------------------------
opencode_home="$tmp/opencode-home"
mkdir -p "$opencode_home/.config/opencode" "$tmp/opencode-data" "$tmp/opencode-state" "$tmp/opencode-cache"
# The runner's plugin and its build-installed SDK. Without the SDK OpenCode
# installs it over the network on a cold start; missing preparation fails
# here instead (as in opencode-continuation.test.sh).
cp -R "$opencode_config_dir/lcars-telemetry.js" "$opencode_config_dir/package.json" \
  "$opencode_config_dir/package-lock.json" "$opencode_config_dir/node_modules" \
  "$opencode_home/.config/opencode/" || fail "runner OpenCode plugin or SDK is missing"
jq -n --arg url "$base_url" '{
  plugin: ["./lcars-telemetry.js"],
  provider: { "hook-test": {
    npm: "@ai-sdk/openai-compatible", name: "hook-test",
    options: { baseURL: $url, apiKey: "hook-test" },
    models: { test: { name: "test" } } } }
}' > "$opencode_home/.config/opencode/opencode.json"
printf '{}\n' > "$tmp/opencode-models.json"
printf '{}\n' > "$tmp/not-a-credential.json"
# `opencode run` ends on its first idle, which the plugin reports as stop.
(
  cd "$tmp/work"
  run_env "$opencode_home" XDG_CONFIG_HOME="$opencode_home/.config" \
    XDG_DATA_HOME="$tmp/opencode-data" XDG_STATE_HOME="$tmp/opencode-state" \
    XDG_CACHE_HOME="$tmp/opencode-cache" OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_MODELS_PATH="$tmp/opencode-models.json" \
    LCARS_TELEMETRY_CREDENTIALS_FILE="$tmp/not-a-credential.json" \
    timeout -k 2s "${run_timeout_seconds}s" "$opencode_bin" run --model hook-test/test "say ok" < /dev/null
) > "$tmp/opencode.out" 2>&1 || {
  status=$?
  cat "$tmp/opencode.out" >&2
  fail "opencode run exited $status against the localhost provider"
}
await_kinds "$opencode_home" opencode start stop
check_events "$opencode_home" opencode
