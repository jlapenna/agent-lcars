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
jq -e '.plugin == ["./lcars-session.js", "./context-lifecycle.js"]' "$config" >/dev/null ||
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
grep -Fq 'RUN bash /usr/local/lib/agent-lcars/opencode-continuation-test/opencode-continuation.test.sh' "$runner_dockerfile" ||
  fail "runner image no longer exercises the real OpenCode continuation contract"

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
