#!/usr/bin/env bash
# Contract tests for opencode.json.
#
# Every failure mode below is silent in production: OpenCode does not error on
# a missing instructions file or a mis-scoped prompt, it just sends a
# different system message, and the only symptom is an agent that behaves
# worse for reasons nothing logs.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="$repo_root/agents/opencode/opencode.json"
runner_dockerfile="$repo_root/apps/runner-autoscaler/runner-image/Dockerfile"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test -f "$config" || fail "opencode.json is missing"
jq -e . "$config" >/dev/null || fail "opencode.json is not valid JSON"

# --- instructions files must exist -------------------------------------------
# A renamed or moved instructions file does not fail the run. OpenCode drops it
# and the standing orders simply stop reaching the model, which is exactly the
# state agent-lcars#1242 was about.
mapfile -t instruction_paths < <(jq -r '.instructions[]? // empty' "$config")
if [ "${#instruction_paths[@]}" -eq 0 ]; then
  fail "opencode.json declares no instructions; the standing orders reach the model through that field (#1242)"
fi
config_dir="$(dirname "$config")"
for path in "${instruction_paths[@]}"; do
  case "$path" in
    http://* | https://*) continue ;;
    '~/.config/opencode/'*) path="$config_dir/${path##*/}" ;;
    *) path="$config_dir/$path" ;;
  esac
  test -f "$path" ||
    fail "instructions entry '$path' does not exist; OpenCode drops missing files silently"
done
jq -e '.instructions == ["~/.config/opencode/instructions.md"]' "$config" >/dev/null ||
  fail "runner-global instructions must use a home-relative path; ./ resolves from each workspace and is silently dropped"

# --- the standing orders must still say the thing they exist to say ----------
orders="$repo_root/agents/opencode/instructions.md"
test -f "$orders" || fail "agents/opencode/instructions.md is missing"
grep -Fq "Commit and push at the first working slice" "$orders" ||
  fail "the standing orders no longer carry the commit-early rule they exist for"

# --- native session identity reaches OpenCode tool subprocesses ----------------
# A fresh session is created inside `opencode run`, too late for direct-runner.sh
# to export its id. OpenCode's shell.env hook receives the authoritative native
# sessionID at each tool call; this plugin bridges that value into the same
# LCARS_SESSION_ID contract used by the annotation CLI.
session_plugin="$repo_root/agents/opencode/lcars-session.js"
test -f "$session_plugin" || fail "agents/opencode/lcars-session.js is missing"
jq -e '.plugin == ["./lcars-session.js", "./context-lifecycle.js", "./lcars-telemetry.js"]' "$config" >/dev/null ||
  fail "opencode.json must load the native LCARS session environment plugin"
plugin_url="data:text/javascript;base64,$(base64 -w0 "$session_plugin")"
node --input-type=module - "$plugin_url" <<'NODE'
import assert from 'node:assert/strict';

const module = await import(process.argv[2]);
const hooks = await module.default();

const native = { env: { KEEP: 'yes', LCARS_SESSION_ID: 'stale' } };
await hooks['shell.env'](
  { cwd: '/repo', sessionID: 'ses_native_123', callID: 'call_1' },
  native,
);
assert.deepEqual(native.env, {
  KEEP: 'yes',
  LCARS_SESSION_ID: 'ses_native_123',
});

const absent = { env: { KEEP: 'yes' } };
await hooks['shell.env']({ cwd: '/repo', callID: 'call_2' }, absent);
assert.deepEqual(absent.env, { KEEP: 'yes' });
NODE

# Protect request history and authoritative instructions at the plugin boundary.
node "$repo_root/tools/opencode-context.test.mjs"
grep -Fq '/repo/agents/opencode/context-lifecycle.js' "$runner_dockerfile" ||
  fail "runner image no longer installs the context lifecycle plugin"
grep -Fq 'RUN --network=none bash /usr/local/lib/agent-lcars/opencode-continuation-test/opencode-continuation.test.sh' "$runner_dockerfile" ||
  fail "runner image must exercise the real OpenCode continuation contract without registry access"

# --- agent.*.prompt must stay unset ------------------------------------------
# Measured 2026-08-16 against opencode 1.18.18 by capturing the wire request:
# setting `agent.build.prompt` REPLACES OpenCode's stock system prompt rather
# than appending to it. The system message went 19,602 -> 10,929 characters and
# lost "You are opencode, an interactive CLI tool..." along with all of its
# tool guidance. `instructions` is the additive field; it lands in the same
# system message without destroying anything.
if jq -e '.agent // {} | to_entries | map(select(.value.prompt)) | length > 0' "$config" >/dev/null; then
  fail "agent.*.prompt REPLACES OpenCode's stock system prompt (measured, opencode 1.18.18) - use .instructions to add text"
fi

# Explicit input plus headroom must fit the backend; a completed-turn usage
# threshold is not a hard admission limit for the next batch of tool results.
jq -e '
  .compaction.reserved as $reserved |
  .provider.homelab.models | to_entries | all(.[].value.limit;
    .input > $reserved and (.input - $reserved) > 50000 and
    .input + .output < .context and .output >= 4096)
' "$config" >/dev/null || fail "model limits lack a usable explicit input budget and backend headroom"

# --- the runner owns the shared configuration --------------------------------
# The provider config and standing instructions apply to every agent job, so
# they belong in the one managed runner image, not in each consumer checkout.
# A source-level contract catches either half of a relative instructions path
# being moved without the other, and prevents a later workspace download from
# recreating the retired copy-on-every-run design.
jq -e '.provider.homelab.options.apiKey == "{file:/run/secrets/opencode-llm-api-key}"' "$config" >/dev/null ||
  fail "the OpenCode provider must read its LiteLLM key from the file mount, never an agent-inherited environment variable"
jq -e '.skills == ["/opt/repo-tools/plugins/repo-tools/skills"]' "$config" >/dev/null ||
  fail "OpenCode must load repo-tools skills from the shared runner checkout"
grep -Fq '/repo/agents/opencode/opencode.json' "$runner_dockerfile" ||
  fail "runner image no longer installs the shared opencode.json"
grep -Fq '/home/runner/.config/opencode/opencode.json' "$runner_dockerfile" ||
  fail "runner image does not install opencode.json at the runner global config path"
grep -Fq '/repo/agents/opencode/instructions.md' "$runner_dockerfile" ||
  fail "runner image no longer installs the OpenCode standing instructions"
grep -Fq '/home/runner/.config/opencode/instructions.md' "$runner_dockerfile" ||
  fail "runner image does not preserve opencode.json's relative instructions path"
grep -Fq '/repo/agents/opencode/lcars-session.js' "$runner_dockerfile" ||
  fail "runner image no longer installs the OpenCode LCARS session plugin"
grep -Fq '/home/runner/.config/opencode/lcars-session.js' "$runner_dockerfile" ||
  fail "runner image does not preserve opencode.json's relative session plugin path"
grep -Fq '/home/runner/.config/opencode/lcars-telemetry.js' "$runner_dockerfile" ||
  fail "runner image does not install the OpenCode hook telemetry plugin beside opencode.json"
# The telemetry plugin must stay inert on a dispatched runner that did not
# select hook telemetry (no LCARS_TELEMETRY_CREDENTIALS_FILE).
telemetry_plugin="$repo_root/agents/opencode/lcars-telemetry.js"
LCARS_RUN_ID=run-fixture LCARS_TELEMETRY_CREDENTIALS_FILE= node --input-type=module - \
  "data:text/javascript;base64,$(base64 -w0 "$telemetry_plugin")" <<'NODE' ||
import assert from 'node:assert/strict';
const module = await import(process.argv[2]);
assert.deepEqual(await module.default({ client: {}, directory: '/' }), {});
NODE
  fail "lcars-telemetry.js must be inert on a runner without hook telemetry"
# Event mapping, throttling, subagent skip, report coalescing, and snapshot
# hygiene, against a stub SDK client and a fake `lcars` that records each
# payload and then deletes the snapshot the way `lcars hook opencode` does.
plugin_tmp="$(mktemp -d)"
mkdir -p "$plugin_tmp/home/.local/bin" "$plugin_tmp/tmp" "$plugin_tmp/capture" \
  "$plugin_tmp/tmp/lcars-opencode-stale01" "$plugin_tmp/tmp/lcars-opencode-fresh01"
touch -d '1 hour ago' "$plugin_tmp/tmp/lcars-opencode-stale01"
cat > "$plugin_tmp/home/.local/bin/lcars" <<'FAKE'
#!/bin/sh
n="$(date +%s%N)"
cat > "$CAPTURE_DIR/$n.payload"
snapshot="$(jq -r .transcript_path "$CAPTURE_DIR/$n.payload")"
cp "$snapshot" "$CAPTURE_DIR/$n.snapshot"
rm -rf "$(dirname "$snapshot")"
FAKE
chmod +x "$plugin_tmp/home/.local/bin/lcars"
HOME="$plugin_tmp/home" TMPDIR="$plugin_tmp/tmp" CAPTURE_DIR="$plugin_tmp/capture" \
  LCARS_RUN_ID= node --input-type=module - \
  "data:text/javascript;base64,$(base64 -w0 "$telemetry_plugin")" <<'NODE' ||
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const capture = process.env.CAPTURE_DIR;
const sessions = {
  ses_main: { id: 'ses_main', directory: '/work/main' },
  ses_child: { id: 'ses_child', directory: '/work/main', parentID: 'ses_main' },
};
let messageCalls = 0;
let releaseGet;
let holdGet = false;
const client = {
  session: {
    get: async ({ path }) => {
      if (holdGet) await new Promise((resolve) => { releaseGet = resolve; });
      return { data: sessions[path.id] };
    },
    messages: async ({ path }) => {
      messageCalls += 1;
      return { data: [{ info: { id: 'msg_1', role: 'user', sessionID: path.id }, parts: [] }] };
    },
  },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const payloads = () =>
  readdirSync(capture)
    .filter((name) => name.endsWith('.payload'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(capture, name), 'utf8')));
async function until(count) {
  for (let i = 0; i < 200 && payloads().length < count; i++) await sleep(25);
  assert.equal(payloads().length, count);
}

const module = await import(process.argv[2]);
const { event } = await module.default({ client, directory: '/fallback' });
const send = (type, properties) => event({ event: { type, properties } });

await send('session.created', { info: sessions.ses_child });
await send('session.idle', { sessionID: 'ses_child' });
await send('session.created', { info: sessions.ses_main });
await until(1);
await send('message.updated', { info: { id: 'msg_1', role: 'user', sessionID: 'ses_main' } });
await until(2);
await send('message.updated', { info: { id: 'msg_1', role: 'user', sessionID: 'ses_main' } });
await send('message.part.updated', { part: { type: 'tool', sessionID: 'ses_main', state: { status: 'completed' } } });
await until(3);
await send('message.part.updated', { part: { type: 'tool', sessionID: 'ses_main', state: { status: 'completed' } } });
await send('session.idle', { sessionID: 'ses_main' });
await until(4);
// Events arriving while a report is in flight collapse to the most
// important one, run after the current report.
holdGet = true;
await send('session.deleted', { info: sessions.ses_main });
await sleep(50);
holdGet = false;
await send('session.idle', { sessionID: 'ses_main' });
await send('session.idle', { sessionID: 'ses_main' });
releaseGet();
await until(6);
await sleep(200);

assert.deepEqual(
  payloads().map((p) => p.hook_event_name),
  ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd', 'Stop'],
);
for (const payload of payloads()) {
  assert.equal(payload.session_id, 'ses_main');
  assert.equal(payload.cwd, '/work/main');
  assert.match(payload.transcript_path, /lcars-opencode-[A-Za-z0-9]{6}\/export\.json$/);
}
const snapshot = JSON.parse(
  readFileSync(join(capture, readdirSync(capture).find((n) => n.endsWith('.snapshot'))), 'utf8'),
);
assert.equal(snapshot.info.id, 'ses_main');
assert.equal(snapshot.messages.length, 1);
// The subagent's history was never fetched.
assert.equal(messageCalls, 6);
assert.deepEqual(
  readdirSync(process.env.TMPDIR).filter((n) => n.startsWith('lcars-opencode-')),
  ['lcars-opencode-fresh01'],
);
NODE
  fail "lcars-telemetry.js event handling regressed"
rm -rf "$plugin_tmp"
grep -Fq 'https://github.com/jlapenna/repo-tools.git' "$runner_dockerfile" ||
  fail "runner image no longer clones repo-tools for OpenCode"
grep -Fq 'git init /opt/repo-tools' "$runner_dockerfile" ||
  fail "runner image no longer checks out repo-tools at /opt/repo-tools for OpenCode"
grep -Fq '/usr/local/lib/agent-lcars/install-opencode-release.sh' "$runner_dockerfile" ||
  fail "runner image must use its reviewed OpenCode release installer"
if grep -Fq 'https://opencode.ai/install' "$runner_dockerfile"; then
  fail "runner image must not use a mutable action installer as root"
fi
echo "opencode-config: ok"
