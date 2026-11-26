#!/usr/bin/env bash
# Contract tests for opencode.json and the dual v1/v2 OpenCode plugin folders.
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

# --- plugin folders & permissions --------------------------------------------
jq -e '.plugin == ["./lcars-session", "./context-lifecycle", "./lcars-telemetry", "./hindsight"]' "$config" >/dev/null ||
  fail "opencode.json must load the four folder plugins (./lcars-session, ./context-lifecycle, ./lcars-telemetry, ./hindsight)"
jq -e '.permission.task == "deny" and .permission.subagent == "deny" and .permission.execute == "deny" and .permission.question == "deny" and .permission.generate_image == "deny"' "$config" >/dev/null ||
  fail "opencode.json must deny subagent/task delegation, Code Mode execute, interactive questions, and image generation by default"

jq -e '.automations == false' "$config" "$config_dir/review-overlay-v2.json" |
  jq -es '. == [true, true]' >/dev/null ||
  fail "the runner configuration and v2 review overlay must disable automations"

for plugin_name in lcars-session context-lifecycle lcars-telemetry hindsight; do
  plugin_dir="$repo_root/agents/opencode/$plugin_name"
  test -f "$plugin_dir/package.json" || fail "agents/opencode/$plugin_name/package.json is missing"
  test -f "$plugin_dir/index.js" || fail "agents/opencode/$plugin_name/index.js is missing"
  test -f "$plugin_dir/v1.js" || fail "agents/opencode/$plugin_name/v1.js is missing"
  jq -e '.type == "module" and .main == "./v1.js" and .exports["."] == "./v1.js" and .exports["./server"] == "./index.js"' \
    "$plugin_dir/package.json" >/dev/null ||
    fail "agents/opencode/$plugin_name/package.json lacks dual v1/v2 exports"
done

session_v1="$repo_root/agents/opencode/lcars-session/v1.js"
session_v2="$repo_root/agents/opencode/lcars-session/index.js"
node --input-type=module - "$session_v1" "$session_v2" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const modV1 = await import(pathToFileURL(process.argv[2]).href);
const modV2 = await import(pathToFileURL(process.argv[3]).href);
assert.equal(modV2.default.id, 'lcars-session');
assert.equal(modV2.default.server, modV1.default);
assert.equal(await modV2.default.setup({}), undefined);

const hooks = await modV1.default();
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
python3 "$repo_root/tools/opencode-continuation-exit.test.py"
grep -Fq '/repo/agents/opencode/context-lifecycle' "$runner_dockerfile" ||
  fail "runner image no longer installs the context lifecycle plugin"
python3 - "$runner_dockerfile" "$repo_root/apps/runner-autoscaler/runner-image/hook-telemetry.test.sh" <<'PYTHON'
import pathlib, sys
image, hook = (pathlib.Path(name).read_text() for name in sys.argv[1:])
logical = ' '.join(image.replace('\\\n', '').split())
expected = ('RUN --network=none python3 /usr/local/lib/agent-lcars/drain-hook-test-clients.test.py && '
  'case "$(uname -m)" in aarch64 | arm64) claude --version && codex --version && opencode --version ;; '
  '*) bash /usr/local/lib/agent-lcars/hook-telemetry.test.sh ;; esac')
assert expected in logical, 'runner image must execute the full hook gate on native builds without registry access'
assert hook.rstrip().splitlines()[-1] == 'exec bash "$(dirname "${BASH_SOURCE[0]}")/opencode-continuation.test.sh"', 'full hook gate must unconditionally transfer to real OpenCode continuation'
PYTHON

# --- agent.*.prompt must stay unset ------------------------------------------
if jq -e '.agent // {} | to_entries | map(select(.value.prompt)) | length > 0' "$config" >/dev/null; then
  fail "agent.*.prompt REPLACES OpenCode's stock system prompt - use .instructions to add text"
fi

# Explicit input plus headroom must fit the backend.
jq -e '
  .compaction.reserved as $reserved |
  .provider.homelab.models | to_entries | all(.[].value.limit;
    .input > $reserved and (.input - $reserved) > 50000 and
    .input + .output < .context and .output >= 4096)
' "$config" >/dev/null || fail "model limits lack a usable explicit input budget and backend headroom"

# --- the runner owns the shared configuration --------------------------------
jq -e '.provider.homelab.options.apiKey == "{file:/run/secrets/opencode-llm-api-key}"' "$config" >/dev/null ||
  fail "the OpenCode provider must read its LiteLLM key from the file mount, never an agent-inherited environment variable"
jq -e '.skills == ["/opt/repo-tools/plugins/repo-tools/skills",
  "/home/runner/.claude/plugins/marketplaces/googlechrome/skills",
  "/home/runner/.claude/plugins/marketplaces/goland-claude-marketplace/plugin/skills"]' "$config" >/dev/null ||
  fail "OpenCode must load repo-tools skills from the shared runner checkout and the upstream guidance plugins from the runner's Claude marketplace checkouts"
grep -Fq '/repo/agents/opencode/opencode.json' "$runner_dockerfile" ||
  fail "runner image no longer installs the shared opencode.json"
grep -Fq '/home/runner/.config/opencode/' "$runner_dockerfile" ||
  fail "runner image does not install opencode.json at the runner global config path"
grep -Fq '/repo/agents/opencode/instructions.md' "$runner_dockerfile" ||
  fail "runner image no longer installs the OpenCode standing instructions"
grep -Fq '/repo/agents/opencode/lcars-session' "$runner_dockerfile" ||
  fail "runner image no longer installs the OpenCode LCARS session plugin"
grep -Fq '/home/runner/.config/opencode/lcars-session' "$runner_dockerfile" ||
  fail "runner image does not preserve opencode.json's relative session plugin path"
grep -Fq '/home/runner/.config/opencode/lcars-telemetry' "$runner_dockerfile" ||
  fail "runner image does not install the OpenCode hook telemetry plugin beside opencode.json"
grep -Fq '/home/runner/.config/opencode/hindsight' "$runner_dockerfile" ||
  fail "runner image does not install the OpenCode Hindsight plugin beside opencode.json"
grep -Fq 'npm ci --prefix /home/runner/.config/opencode --omit=dev --ignore-scripts' "$runner_dockerfile" ||
  fail "runner image must install @opencode/plugin from the committed lockfile via npm ci --ignore-scripts"

hindsight_v1="$repo_root/agents/opencode/hindsight/v1.js"
hindsight_v2="$repo_root/agents/opencode/hindsight/index.js"
HINDSIGHT_DISABLED=true node --input-type=module - "$hindsight_v1" "$hindsight_v2" <<'NODE' ||
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const v1 = await import(pathToFileURL(process.argv[2]).href);
const v2 = await import(pathToFileURL(process.argv[3]).href);
assert.deepEqual(await v1.default({ client: {}, directory: '/' }), {});
assert.equal(await v2.default.setup({}), undefined);
NODE
  fail "hindsight plugin must be inert when HINDSIGHT_DISABLED=true"
HINDSIGHT_CONFIG="/nonexistent/hindsight/coding-agent.json" node --input-type=module - "$hindsight_v1" "$hindsight_v2" <<'NODE' ||
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const v1 = await import(pathToFileURL(process.argv[2]).href);
const v2 = await import(pathToFileURL(process.argv[3]).href);
assert.deepEqual(await v1.default({ client: {}, directory: '/' }), {});
assert.equal(await v2.default.setup({}), undefined);
NODE
  fail "hindsight plugin must be inert when coding-agent.json is absent"

telemetry_v1="$repo_root/agents/opencode/lcars-telemetry/v1.js"
telemetry_v2="$repo_root/agents/opencode/lcars-telemetry/index.js"
LCARS_RUN_ID=run-fixture LCARS_TELEMETRY_CREDENTIALS_FILE= node --input-type=module - "$telemetry_v1" "$telemetry_v2" <<'NODE' ||
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const v1 = await import(pathToFileURL(process.argv[2]).href);
const v2 = await import(pathToFileURL(process.argv[3]).href);
assert.deepEqual(await v1.default({ client: {}, directory: '/' }), {});
assert.equal(await v2.default.setup({}), undefined);
NODE
  fail "lcars-telemetry must be inert on a runner without hook telemetry"

# Event mapping, throttling, subagent skip, report coalescing, and snapshot
# hygiene across both v1 and v2 plugin entrypoints.
plugin_tmp="$(mktemp -d)"
mkdir -p "$plugin_tmp/home/.local/bin" "$plugin_tmp/tmp" "$plugin_tmp/capture" \
  "$plugin_tmp/capture2" \
  "$plugin_tmp/tmp/lcars-opencode-stale01" "$plugin_tmp/tmp/lcars-opencode-fresh01"
touch -d '1 hour ago' "$plugin_tmp/tmp/lcars-opencode-stale01"
cat > "$plugin_tmp/home/.local/bin/lcars" <<'FAKE'
#!/bin/sh
n="$(date +%s%N)"
cat > "$CAPTURE_DIR/$n.pending"
snapshot="$(jq -r '.transcript_path // empty' "$CAPTURE_DIR/$n.pending")"
case "$snapshot" in
  "$TMPDIR"/lcars-opencode-*/export.json)
    cp "$snapshot" "$CAPTURE_DIR/$n.snapshot"
    rm -rf "$(dirname "$snapshot")"
    ;;
esac
mv "$CAPTURE_DIR/$n.pending" "$CAPTURE_DIR/$n.payload"
FAKE
chmod +x "$plugin_tmp/home/.local/bin/lcars"
HOME="$plugin_tmp/home" TMPDIR="$plugin_tmp/tmp" CAPTURE_DIR="$plugin_tmp/capture" \
  LCARS_RUN_ID= node --input-type=module - "$telemetry_v1" <<'NODE' ||
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
      const session = sessions[path.id];
      if (holdGet) await new Promise((resolve) => { releaseGet = resolve; });
      return { data: session };
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

const module = await import(pathToFileURL(process.argv[2]).href);
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
holdGet = true;
await send('session.idle', { sessionID: 'ses_main' });
await sleep(50);
holdGet = false;
const deleted = sessions.ses_main;
delete sessions.ses_main;
await send('session.deleted', { info: deleted });
await send('session.idle', { sessionID: 'ses_main' });
releaseGet();
await until(6);
await sleep(200);

assert.deepEqual(
  payloads().map((p) => p.hook_event_name),
  ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Stop', 'SessionEnd'],
);
for (const payload of payloads()) {
  assert.equal(payload.session_id, 'ses_main');
  assert.equal(payload.cwd, '/work/main');
  if (payload.hook_event_name === 'SessionEnd') {
    assert.equal(payload.transcript_path, undefined);
  } else {
    assert.match(payload.transcript_path, /lcars-opencode-[A-Za-z0-9]{6}\/export\.json$/);
  }
}
const snapshot = JSON.parse(
  readFileSync(join(capture, readdirSync(capture).find((n) => n.endsWith('.snapshot'))), 'utf8'),
);
assert.equal(snapshot.info.id, 'ses_main');
assert.equal(snapshot.messages.length, 1);
assert.equal(messageCalls, 5);
assert.deepEqual(
  readdirSync(process.env.TMPDIR).filter((n) => n.startsWith('lcars-opencode-')),
  ['lcars-opencode-fresh01'],
);
NODE
  fail "lcars-telemetry v1 event handling regressed"

HOME="$plugin_tmp/home" TMPDIR="$plugin_tmp/tmp" CAPTURE_DIR="$plugin_tmp/capture2" \
  LCARS_RUN_ID= node --input-type=module - "$telemetry_v2" <<'NODE' ||
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const capture = process.env.CAPTURE_DIR;
const sessions = {
  ses_v2: { id: 'ses_v2', location: { directory: '/work/v2' } },
  ses_child: { id: 'ses_child', parentID: 'ses_v2', location: { directory: '/work/v2' } },
};
let contextCalls = 0;
const queue = [];
let wake;
const push = (type, data) => {
  queue.push({ type, data });
  wake?.();
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

const module = await import(pathToFileURL(process.argv[2]).href);
const cleanup = await module.default.setup({
  location: { directory: '/fallback' },
  session: {
    get: async ({ sessionID }) => sessions[sessionID],
    context: async () => {
      contextCalls += 1;
      return [{ id: 'msg_1', type: 'user', content: [{ type: 'text', text: 'hi' }] }];
    },
  },
  event: {
    subscribe: async function* ({ signal }) {
      while (!signal?.aborted) {
        while (queue.length > 0) yield queue.shift();
        await new Promise((resolve) => {
          wake = resolve;
          signal?.addEventListener('abort', resolve, { once: true });
        });
      }
    },
  },
});

push('session.created', { sessionID: 'ses_child', parentID: 'ses_v2' });
push('session.execution.succeeded', { sessionID: 'ses_child' });
push('session.execution.started', { sessionID: 'ses_v2' });
await until(1);
push('session.inbox.delivered', { sessionID: 'ses_v2', inboxID: 'inb_1' });
await until(2);
push('session.inbox.delivered', { sessionID: 'ses_v2', inboxID: 'inb_1' });
push('session.tool.success', { sessionID: 'ses_v2' });
await until(3);
push('session.execution.succeeded', { sessionID: 'ses_v2' });
await until(4);
delete sessions.ses_v2;
push('session.deleted', { sessionID: 'ses_v2', location: { directory: '/work/v2' } });
await until(5);
await cleanup();

assert.deepEqual(
  payloads().map((p) => p.hook_event_name),
  ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'],
);
assert.equal(contextCalls, 4);
NODE
  fail "lcars-telemetry v2 event handling regressed"
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
