#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
# Exported: the fake curl/git/gh/claude binaries below run as separate
# processes (found via PATH, not sourced), so they only see `tmp` if it is
# actually in their environment -- an unexported `tmp` would leave every
# `$tmp/...` reference inside those heredocs resolving to an empty prefix
# once direct-runner.sh execs them for real.
tmp="$(mktemp -d)"
export tmp
trap 'rm -rf "$tmp"' EXIT

# --- Fake baked image tree -------------------------------------------------
# direct-runner.sh's PREPARE_DISPATCH_DIR default assumes prepare.sh's own
# unmodified `$GITHUB_ACTION_PATH/../../../agents/shared/skills/...` climb
# resolves against a REAL baked filesystem layout: the Dockerfile places
# prepare-agent-dispatch/ at .github/actions/prepare-agent-dispatch under
# /usr/local/lib/agent-lcars/ (treated as a fake "repo root"), with
# agents/shared/skills/ as its sibling at that same fake root -- see the
# Dockerfile's own comment next to those COPY lines. Building that SAME
# relative layout here, from this repo's real checked-in scripts, is what
# actually exercises the climb instead of masking it (fix round 1,
# review-critical): pointing PREPARE_DISPATCH_DIR straight at
# $repo_root/.github/actions/prepare-agent-dispatch, as an earlier version
# of this test did, makes the climb land on the REAL repo root, which also
# happens to have agents/shared/skills -- so that version of this test
# passed even though the real image never baked that directory at all.
baked="$tmp/baked"
mkdir -p "$baked/.github/actions"
cp -R "$repo_root/.github/actions/prepare-agent-dispatch" "$baked/.github/actions/prepare-agent-dispatch"
mkdir -p "$baked/.github/actions/verify-deliverable"
cp "$repo_root/.github/actions/verify-deliverable/verify-deliverable.sh" \
  "$baked/.github/actions/verify-deliverable/verify-deliverable.sh"
mkdir -p "$baked/agents/shared/skills"
cp -R "$repo_root/agents/shared/skills/." "$baked/agents/shared/skills/"

BAKED_PREPARE_DISPATCH_DIR="$baked/.github/actions/prepare-agent-dispatch"
BAKED_VERIFY_DELIVERABLE="$baked/.github/actions/verify-deliverable/verify-deliverable.sh"
# sidecar-lifecycle.sh only needs this baked entrypoint to exist before it
# delegates to the fake `node` below. Keep it separate from the source tree:
# the real runner image contains the compiled bundle, while this shell harness
# deliberately verifies the lifecycle arguments without starting Firestore.
cp "$repo_root/apps/telemetry-watcher/bin/sidecar-lifecycle.sh" "$baked/sidecar-lifecycle.sh"
cp "$repo_root/apps/telemetry-watcher/bin/job-daemon.sh" "$baked/job-daemon.sh"
chmod +x "$baked/sidecar-lifecycle.sh" "$baked/job-daemon.sh"
BAKED_SIDECAR_LIFECYCLE="$baked/sidecar-lifecycle.sh"
printf '%s\n' '// fake baked telemetry sidecar' > "$baked/sidecar.cjs"

# A distinctive value (not a real secret) asserted absent from every place
# a leaked credential could land -- $workspace/.git/config and the fake
# git's recorded clone argv (fix round 1, review-critical #2).
export FAKE_TOKEN="fake-checkout-token-xyz789"

# A distinctive value (not a real secret) for the claude OAuth token file
# -- asserted present in the fake claude's own recorded env
# (CLAUDE_ENV_TOKEN_LOG) and absent from anywhere a `docker run`-style
# Config.Env leak would show up, mirroring FAKE_TOKEN's own discipline.
export FAKE_CLAUDE_OAUTH_TOKEN="fake-claude-oauth-token-abc123"

# --- Fake binary factory ----------------------------------------------------
# Installs curl/git/gh/claude fakes into "$1/bin". Every curl call in
# direct-runner.sh sends its bearer/url/timeouts via `--config -` (stdin),
# never `-H`/argv (fix round 1: agent-fallback-finalize.yml's own completion
# callback does the same, to keep a bearer token out of `ps aux`/cmdline),
# so this fake curl parses url/data-binary out of that stdin config block
# instead of scanning argv for a bare "http*" token. Each scenario exports
# its own COMPLETE_LOG/GIT_CLONE_ARGV_LOG so scenarios never share state.
make_fake_bins() {
  bindir="$1"
  mkdir -p "$bindir"

  cat > "$bindir/curl" <<'FAKE'
#!/usr/bin/env bash
url=""
config_stdin=false
prev=""
for arg in "$@"; do
  if [ "$prev" = "--config" ] && [ "$arg" = "-" ]; then
    config_stdin=true
  fi
  case "$arg" in
    http*) url="$arg" ;;
  esac
  prev="$arg"
done

data_binary_file=""
if $config_stdin; then
  config_body="$(cat)"
  cfg_url="$(printf '%s\n' "$config_body" | sed -nE 's/^url = "(.*)"$/\1/p')"
  [ -n "$cfg_url" ] && url="$cfg_url"
  data_binary_file="$(printf '%s\n' "$config_body" | sed -nE 's/^data-binary = "@(.*)"$/\1/p')"
  # Fails closed if a caller ever regresses and puts the raw token back in
  # the URL -- proves this for every call a scenario makes, not just the
  # one a scenario explicitly asserts on afterward.
  case "$url" in
    *"$FAKE_TOKEN"*)
      echo "fake curl: refusing to leak token via URL: $url" >&2
      exit 1
      ;;
  esac
fi

case "$url" in
  */brief)
    if [ "${FAKE_BRIEF_FAIL:-}" = "1" ]; then
      echo "fake curl: simulated brief failure (expired/invalid run token)" >&2
      exit 22
    fi
    if [ "${FAKE_BRIEF_NO_RESUME:-}" = "1" ]; then
      cat <<JSON
{"id":"01DIRECTRUNNERTESTFIXTURE1","spec":{"title":"t","description":"d","pipeline":"${FAKE_PIPELINE:-claude}","target":{"repo":"octo/example"}},"anchor":{"type":"work","id":"01DIRECTRUNNERTESTFIXTURE1","title":"t","body":"d","target_repo":"octo/example","html_url":"https://lcars.test/work/01DIRECTRUNNERTESTFIXTURE1"},"attemptId":"g1:work:01DIRECTRUNNERTESTFIXTURE1/r1","generation":1,"intentId":"work:01DIRECTRUNNERTESTFIXTURE1/r1"}
JSON
    else
      cat <<JSON
{"id":"01DIRECTRUNNERTESTFIXTURE1","spec":{"title":"t","description":"d","pipeline":"${FAKE_PIPELINE:-claude}","target":{"repo":"octo/example"}},"anchor":{"type":"work","id":"01DIRECTRUNNERTESTFIXTURE1","title":"t","body":"d","target_repo":"octo/example","html_url":"https://lcars.test/work/01DIRECTRUNNERTESTFIXTURE1"},"attemptId":"g1:work:01DIRECTRUNNERTESTFIXTURE1/r1","generation":1,"intentId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","resume":{"sessionId":"sess_1","transcriptGcsUri":"gs://bucket/runs/x/claude-code/sess_1.jsonl"}}
JSON
    fi
    ;;
  */checkout-token)
    if [ "${FAKE_CHECKOUT_TOKEN_FAIL:-}" = "1" ]; then
      echo "fake curl: simulated checkout-token failure" >&2
      exit 22
    fi
    echo "{\"token\":\"$FAKE_TOKEN\",\"expiresAt\":\"2026-08-27T01:00:00.000Z\"}"
    ;;
  */codex-auth)
    if printf '%s\n' "$config_body" | grep -qF 'request = "PUT"'; then
      [ -n "$data_binary_file" ] && cat "$data_binary_file" >> "$CODEX_AUTH_PERSIST_LOG"
      echo '{"status":"updated"}'
    else
      auth='{"tokens":{"access":"old"}}'
      auth_b64="$(printf '%s' "$auth" | base64 -w0)"
      auth_sha="$(printf '%s' "$auth" | sha256sum | awk '{print $1}')"
      printf '{"authBase64":"%s","generation":"7","sha256":"%s"}\n' "$auth_b64" "$auth_sha"
    fi
    ;;
  */heartbeat)
    echo '{"runId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","expiresAt":"2026-08-27T01:00:00.000Z"}'
    ;;
  */complete)
    {
      echo "URL=$url"
      [ -n "$data_binary_file" ] && cat "$data_binary_file"
    } >> "$COMPLETE_LOG"
    echo '{"runId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","state":"finished"}'
    ;;
  *)
    echo "fake curl: unhandled URL $url" >&2
    exit 1
    ;;
esac
FAKE
  chmod +x "$bindir/curl"

  # `clone`/`config` are matched anywhere in argv, not at $1, because
  # direct-runner.sh's clone now runs as `git -c http.extraheader=... clone
  # ...` (fix round 1 #2) -- `$1` would be `-c`, not `clone`, under simpler
  # positional matching.
  cat > "$bindir/git" <<'FAKE'
#!/usr/bin/env bash
is_clone=false
is_config=false
for arg in "$@"; do
  case "$arg" in
    clone) is_clone=true ;;
    config) is_config=true ;;
  esac
done
if $is_clone; then
  printf '%s\n' "$*" >> "$GIT_CLONE_ARGV_LOG"
  target="${@: -1}"
  mkdir -p "$target/.git"
elif $is_config; then
  printf '%s\n' "$*" >> ".git/config"
fi
exit 0
FAKE
  chmod +x "$bindir/git"

  cat > "$bindir/gh" <<'FAKE'
#!/usr/bin/env bash
if [[ "$*" == *"pulls?state=all"* ]]; then
  if [ "${FAKE_GH_NO_MATCH:-}" = "1" ]; then
    echo ""
  else
    echo '12'
  fi
  exit 0
fi
echo '[]'
FAKE
  chmod +x "$bindir/gh"

  # Records its argv (including any --resume flag) to $CLAUDE_ARGS_LOG, then
  # ignores every flag, including the real --dangerously-skip-permissions/
  # --allowedTools/--disallowedTools direct-runner.sh passes. Also records
  # its own CLAUDE_CODE_OAUTH_TOKEN env value to $CLAUDE_ENV_TOKEN_LOG --
  # `claude` reads that credential straight from its process environment
  # (no flag carries it), so this is the only way to prove direct-runner.sh
  # actually exported it before invoking `claude`, and to prove it never
  # showed up as a `docker run`-style Config.Env entry the queue-executor
  # side already pins in queue_executor_test.go.
  cat > "$bindir/claude" <<'FAKE'
#!/usr/bin/env bash
echo "$@" >> "$CLAUDE_ARGS_LOG"
printf '%s' "${CLAUDE_CODE_OAUTH_TOKEN:-}" > "$CLAUDE_ENV_TOKEN_LOG"
exit 0
FAKE
  chmod +x "$bindir/claude"

  cat > "$bindir/codex" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then
  exit 0
fi
echo "$@" >> "$CODEX_ARGS_LOG"
printf '%s' "$CODEX_HOME/sessions" > "$CODEX_SESSIONS_DIR_LOG"
mkdir -p "$CODEX_HOME/sessions/2026/08/28"
printf '%s\n' '{"type":"session_meta","payload":{"id":"sess-codex-test"}}' > "$CODEX_HOME/sessions/2026/08/28/sess-codex-test.jsonl"
printf '%s' '{"tokens":{"access":"rotated"}}' > "$CODEX_HOME/auth.json"
if [ "${FAKE_CODEX_BURNED:-}" = "1" ]; then
  echo '{"type":"turn.failed","error":{"message":"refresh token was already used"}}'
  exit 1
fi
if [ "${FAKE_CODEX_STDERR_BURNED:-}" = "1" ]; then
  echo 'Your access token could not be refreshed' >&2
  echo '{"type":"turn.failed","error":{"message":"authentication failed"}}'
  exit 1
fi
if [ "${FAKE_CODEX_FALSE_POSITIVE:-}" = "1" ]; then
  echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"refresh token was already used"}}'
fi
echo '{"type":"turn.completed"}'
exit 0
FAKE
  chmod +x "$bindir/codex"

  # Mirrors .github/actions/resume-session/resume.test.sh's own fake node:
  # records its argv (proving direct-runner.sh's `runner resume` call site
  # passes the right session id/transcript uri/cwd) and either prints a
  # fake resumed local path or, when FAKE_RESUME_FAIL is set, fails closed
  # with no output -- exercising direct-runner.sh's own fail-soft handling
  # (a failed restore must not stop the run, and must not add --resume).
  cat > "$bindir/node" <<'FAKE'
#!/usr/bin/env bash
echo "$@" >> "$NODE_ARGS_LOG"
if [ "${FAKE_RESUME_FAIL:-}" = "1" ]; then
  exit 1
fi
echo "/fake/claude/projects/-fake-cwd/sess_1.jsonl"
FAKE
  chmod +x "$bindir/node"
}

run_scenario() {
  name="$1"
  export FAKE_PIPELINE="${2:-claude}"
  dir="$tmp/$name"
  mkdir -p "$dir/bin"
  make_fake_bins "$dir/bin"

  export PATH="$dir/bin:$PATH"
  export LCARS_RUN_ID="work:01DIRECTRUNNERTESTFIXTURE1/r1"
  export LCARS_RUN_TOKEN="test-token"
  export LCARS_CONSOLE_URL="https://lcars.test"
  if [ "${FAKE_MISSING_RUNNER_TEMP:-}" = "1" ]; then
    # Direct-mode Docker launches do not inherit GitHub Actions' RUNNER_TEMP.
    # Put the script's fallback under this scenario's private directory so
    # this regression test exercises that real container contract without
    # touching a shared /tmp path.
    unset RUNNER_TEMP
    export TMPDIR="$dir/tmp"
    scenario_runner_temp="$TMPDIR/agent-lcars-direct"
  else
    unset TMPDIR
    export RUNNER_TEMP="$dir/runner-temp"
    scenario_runner_temp="$RUNNER_TEMP"
  fi
  export HOME="$dir/home"
  export LCARS_CODEX_VOLATILE_DIR="$dir/codex-volatile"
  mkdir -p "$scenario_runner_temp" "$HOME" "$LCARS_CODEX_VOLATILE_DIR"

  export COMPLETE_LOG="$dir/complete-calls.log"
  export GIT_CLONE_ARGV_LOG="$dir/git-clone-argv.log"
  export CLAUDE_ARGS_LOG="$dir/claude-args.log"
  export NODE_ARGS_LOG="$dir/node-args.log"
  export CLAUDE_ENV_TOKEN_LOG="$dir/claude-env-token.log"
  export CODEX_ARGS_LOG="$dir/codex-args.log"
  export CODEX_SESSIONS_DIR_LOG="$dir/codex-sessions-dir.log"
  export CODEX_AUTH_PERSIST_LOG="$dir/codex-auth-persist.log"

  # Fixture for CLAUDE_TOKEN_FILE: the same shape launchDirectRunnerOnHost's
  # real bind mount produces -- a plain-text file holding just the token --
  # so this test exercises direct-runner.sh's own read-and-export, not a
  # fake standing in for it. FAKE_MISSING_CLAUDE_TOKEN (scenario 4) instead
  # points CLAUDE_TOKEN_FILE at a path this function never creates, so the
  # missing-file branch is exercised for real too.
  if [ "${FAKE_MISSING_CLAUDE_TOKEN:-}" = "1" ]; then
    export CLAUDE_TOKEN_FILE="$dir/nonexistent-claude-token"
  else
    printf '%s' "$FAKE_CLAUDE_OAUTH_TOKEN" > "$dir/claude-code-oauth-token"
    export CLAUDE_TOKEN_FILE="$dir/claude-code-oauth-token"
  fi

  # Bounds the background heartbeat loop's orphaned-sleep lifetime to
  # ~1 second instead of the production 300s default: fake `claude` returns
  # near-instantly, so direct-runner.sh kills (without waiting on) the loop
  # well before its first tick either way, but a short interval keeps a
  # not-yet-reaped `sleep` process from lingering past this test's own exit.
  export HEARTBEAT_INTERVAL_SECONDS=1

  # Point every baked-tool env var at the fake baked tree built above (not
  # the live repo -- see its own header comment), so this test exercises
  # the REAL prepare.sh/verify-deliverable.sh/sidecar-lifecycle.sh through
  # the SAME relative layout the Dockerfile actually produces.
  export PREPARE_DISPATCH_DIR="$BAKED_PREPARE_DISPATCH_DIR"
  export VERIFY_DELIVERABLE="$BAKED_VERIFY_DELIVERABLE"
  export SIDECAR_LIFECYCLE="$BAKED_SIDECAR_LIFECYCLE"

  set +e
  bash "$here/direct-runner.sh"
  rc=$?
  set -e
  workspace="$scenario_runner_temp/checkout"
}

fail() {
  echo "$1" >&2
  exit 1
}

# --- Scenario 1: happy path (pull-request outcome) --------------------------
# `TARGET_REPO` in the fake brief is `octo/example`, not `jlapenna/agent-
# lcars`, so prepare.sh's own `assert-consumer-boundaries.sh` call takes its
# "any other repository" branch and returns immediately.
run_scenario happy-path

[ "$rc" -eq 0 ] || fail "happy path: expected exit 0, got $rc"
[ -f "$COMPLETE_LOG" ] || fail "happy path: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"pull-request"' "$COMPLETE_LOG" ||
  fail "happy path: complete call did not report outcome: pull-request ($(cat "$COMPLETE_LOG"))"

# Fix round 1, review-critical #2: the raw checkout token must never land
# in the persisted git config or in the clone's own recorded argv (only its
# base64-encoded header form, in .git/config, is expected -- that mirrors
# actions/checkout's own persist-credentials shape and does not contain the
# raw token string as a byte-for-byte substring).
if grep -q "$FAKE_TOKEN" "$workspace/.git/config" 2>/dev/null; then
  fail "happy path: raw checkout token leaked into $workspace/.git/config"
fi
if grep -q "$FAKE_TOKEN" "$GIT_CLONE_ARGV_LOG" 2>/dev/null; then
  fail "happy path: raw checkout token leaked into git clone argv ($(cat "$GIT_CLONE_ARGV_LOG"))"
fi

# Final-review fix: direct mode configures its own commit identity (no
# agent-setup/action.yml composite action to do it, unlike GitHub-Actions
# mode) -- assert it actually landed in the checkout's own git config, not
# just that direct-runner.sh ran the config command without erroring.
if ! grep -q "user.email" "$workspace/.git/config" 2>/dev/null; then
  fail "happy path: git commit identity (user.email) was not configured in $workspace/.git/config"
fi

# The fake brief's `resume` object must reach `runner resume` (session id,
# transcript uri, and the checkout cwd), and a successful restore must add
# `--resume <sessionId>` to the claude invocation.
if [ ! -f "$NODE_ARGS_LOG" ]; then
  fail "happy path: direct-runner.sh never invoked \`runner resume\` despite a resume brief"
fi
grep -q -- '--session-id sess_1' "$NODE_ARGS_LOG" ||
  fail "happy path: runner resume was not passed the session id ($(cat "$NODE_ARGS_LOG"))"
grep -q -- '--transcript-uri gs://bucket/runs/x/claude-code/sess_1.jsonl' "$NODE_ARGS_LOG" ||
  fail "happy path: runner resume was not passed the transcript uri ($(cat "$NODE_ARGS_LOG"))"
grep -q -- "--cwd $workspace" "$NODE_ARGS_LOG" ||
  fail "happy path: runner resume was not passed the checkout cwd ($(cat "$NODE_ARGS_LOG"))"
grep -q -- '--resume sess_1' "$CLAUDE_ARGS_LOG" 2>/dev/null ||
  fail "happy path: claude was not passed --resume sess_1 ($(cat "$CLAUDE_ARGS_LOG" 2>/dev/null))"

# The credential-delivery fix under test: CLAUDE_TOKEN_FILE's contents must
# reach claude's own process environment as CLAUDE_CODE_OAUTH_TOKEN.
[ -f "$CLAUDE_ENV_TOKEN_LOG" ] || fail "happy path: claude was never invoked with an env to record"
if [ "$(cat "$CLAUDE_ENV_TOKEN_LOG")" != "$FAKE_CLAUDE_OAUTH_TOKEN" ]; then
  fail "happy path: claude did not see CLAUDE_CODE_OAUTH_TOKEN from CLAUDE_TOKEN_FILE (got $(cat "$CLAUDE_ENV_TOKEN_LOG"))"
fi

echo "scenario happy-path: OK"

# --- Scenario 1a: Codex provider dispatch and auth broker -------------------
# Codex must run without the Claude host-token mount, restore only through the
# run-token broker, and persist the changed auth.json with the exact restored
# generation/hash. A resume object is deliberately present in the brief: Codex
# has archived telemetry but no live-resume implementation, so runner resume
# must remain Claude-only.
export FAKE_MISSING_CLAUDE_TOKEN=1
run_scenario codex-happy codex
unset FAKE_MISSING_CLAUDE_TOKEN

[ "$rc" -eq 0 ] || fail "codex happy path: expected exit 0, got $rc"
[ -s "$CODEX_ARGS_LOG" ] || fail "codex happy path: codex was not invoked"
grep -q -- 'exec --json --dangerously-bypass-approvals-and-sandbox' "$CODEX_ARGS_LOG" ||
  fail "codex happy path: wrong invocation ($(cat "$CODEX_ARGS_LOG"))"
if grep -q -- '--ephemeral' "$CODEX_ARGS_LOG"; then
  fail "codex happy path: ephemeral execution suppresses telemetry sessions"
fi
[ ! -f "$CLAUDE_ARGS_LOG" ] || fail "codex happy path: claude was invoked"
[ -s "$CODEX_SESSIONS_DIR_LOG" ] || fail "codex happy path: fake Codex did not receive its session root"
codex_sessions_dir="$(cat "$CODEX_SESSIONS_DIR_LOG")"
if grep -q -- 'runner resume' "$NODE_ARGS_LOG" 2>/dev/null; then
  fail "codex happy path: Claude resume helper was invoked"
fi
[ -f "$NODE_ARGS_LOG" ] || fail "codex happy path: sidecar never invoked node"
sidecar_session_calls="$(grep -Fc -- "--codex-sessions-dir $codex_sessions_dir" "$NODE_ARGS_LOG" || true)"
if [ "$sidecar_session_calls" -lt 2 ]; then
  fail "codex happy path: sidecar start/finalize did not both receive Codex sessions root ($(cat "$NODE_ARGS_LOG"))"
fi
[ -s "$CODEX_AUTH_PERSIST_LOG" ] || fail "codex happy path: auth.json was not persisted"
jq -e '.generation == "7" and (.restoredSha256 | test("^[0-9a-f]{64}$")) and (.authBase64 | length > 0) and (has("authFailure") | not)' \
  "$CODEX_AUTH_PERSIST_LOG" >/dev/null ||
  fail "codex happy path: persistence payload lost its CAS binding ($(cat "$CODEX_AUTH_PERSIST_LOG"))"
grep -q '"outcome":"pull-request"' "$COMPLETE_LOG" ||
  fail "codex happy path: completion was not a pull request ($(cat "$COMPLETE_LOG"))"
if find "$LCARS_CODEX_VOLATILE_DIR" -mindepth 1 -print -quit | grep -q .; then
  fail "codex happy path: volatile auth/payload files survived exit"
fi

echo "scenario codex-happy: OK"

# A positive #1192 refresh-failure signature must reach the broker as the
# narrow enum that makes persistence an authoritative no-write. The agent run
# itself still fails and reports no-deliverable.
export FAKE_CODEX_BURNED=1
run_scenario codex-burned codex
unset FAKE_CODEX_BURNED

[ "$rc" -ne 0 ] || fail "codex burned auth: expected a non-zero exit"
jq -e '.authFailure == "refresh-token-reused"' "$CODEX_AUTH_PERSIST_LOG" >/dev/null ||
  fail "codex burned auth: broker payload did not carry the exact failure enum ($(cat "$CODEX_AUTH_PERSIST_LOG"))"
grep -q '"outcome":"no-deliverable"' "$COMPLETE_LOG" ||
  fail "codex burned auth: completion did not report no-deliverable ($(cat "$COMPLETE_LOG"))"

echo "scenario codex-burned: OK"

# Agent/task text is untrusted even inside valid JSONL. A signature in an
# agent_message item must not suppress persistence or force failure because
# only top-level `error.message`, `turn.failed.error.message`, and the CLI's
# own stderr are origin diagnostics.
export FAKE_CODEX_FALSE_POSITIVE=1
run_scenario codex-signature-in-agent-text codex
unset FAKE_CODEX_FALSE_POSITIVE

[ "$rc" -eq 0 ] || fail "codex false positive: untrusted agent text forced failure"
jq -e 'has("authFailure") | not' "$CODEX_AUTH_PERSIST_LOG" >/dev/null ||
  fail "codex false positive: untrusted agent text suppressed persistence ($(cat "$CODEX_AUTH_PERSIST_LOG"))"

echo "scenario codex-signature-in-agent-text: OK"

# Codex also emits origin diagnostics on stderr. Capture that stream
# separately from JSONL and classify the known signature there.
export FAKE_CODEX_STDERR_BURNED=1
run_scenario codex-burned-stderr codex
unset FAKE_CODEX_STDERR_BURNED

[ "$rc" -ne 0 ] || fail "codex stderr burned auth: expected a non-zero exit"
jq -e '.authFailure == "access-token-refresh-failed"' "$CODEX_AUTH_PERSIST_LOG" >/dev/null ||
  fail "codex stderr burned auth: origin diagnostic was not classified ($(cat "$CODEX_AUTH_PERSIST_LOG"))"
if find "$LCARS_CODEX_VOLATILE_DIR" -mindepth 1 -print -quit | grep -q .; then
  fail "codex stderr burned auth: volatile auth/payload files survived failure exit"
fi

echo "scenario codex-burned-stderr: OK"

# Provider expansion is explicit. OpenCode remains outside this PR and must
# fail before checkout while still settling the already-claimed run.
run_scenario opencode-unsupported opencode
[ "$rc" -ne 0 ] || fail "unsupported OpenCode: expected a non-zero exit"
[ ! -f "$GIT_CLONE_ARGV_LOG" ] || fail "unsupported OpenCode: checkout ran"
grep -q '"outcome":"no-deliverable"' "$COMPLETE_LOG" ||
  fail "unsupported OpenCode: claimed run was not settled ($(cat "$COMPLETE_LOG"))"

echo "scenario opencode-unsupported: OK"

# --- Scenario 1b: GitHub-Actions temp environment absent -------------------
# A direct-mode container is started by Docker rather than GitHub Actions, so
# it has no inherited RUNNER_TEMP. Its own fallback must be exported before
# prepare-agent-dispatch runs; otherwise prepare.sh fails after clone with
# "RUNNER_TEMP is required" and leaves the claimed work item to time out.
export FAKE_MISSING_RUNNER_TEMP=1
run_scenario missing-runner-temp
unset FAKE_MISSING_RUNNER_TEMP

[ "$rc" -eq 0 ] || fail "missing-runner-temp: expected exit 0, got $rc"
[ -f "$scenario_runner_temp/agent-dispatch/context.json" ] ||
  fail "missing-runner-temp: prepare-agent-dispatch did not create its context"
[ -f "$COMPLETE_LOG" ] ||
  fail "missing-runner-temp: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"pull-request"' "$COMPLETE_LOG" ||
  fail "missing-runner-temp: complete call did not report outcome: pull-request ($(cat "$COMPLETE_LOG"))"

echo "scenario missing-runner-temp: OK"

# --- Scenario 1c: no resume in the brief -------------------------------------
# A brief with no `resume` field must leave direct-runner.sh byte-identical
# to today: no `runner resume` invocation, and claude receives no --resume
# flag at all.
export FAKE_BRIEF_NO_RESUME=1
run_scenario no-resume
unset FAKE_BRIEF_NO_RESUME

[ "$rc" -eq 0 ] || fail "no-resume: expected exit 0, got $rc"
if grep -q -- 'runner resume' "$NODE_ARGS_LOG" 2>/dev/null; then
  fail "no-resume: runner resume was invoked despite no resume field in the brief ($(cat "$NODE_ARGS_LOG"))"
fi
if grep -q -- '--resume' "$CLAUDE_ARGS_LOG" 2>/dev/null; then
  fail "no-resume: claude was passed --resume despite no resume field in the brief ($(cat "$CLAUDE_ARGS_LOG"))"
fi

echo "scenario no-resume: OK"

# --- Scenario 1d: resume present but the restore fails -----------------------
# `runner resume` fails closed (simulating a missing/expired transcript);
# direct-runner.sh's restore is fail-soft -- the run must still proceed to
# a normal pull-request outcome, just without --resume on the claude
# invocation.
export FAKE_RESUME_FAIL=1
run_scenario resume-failed
unset FAKE_RESUME_FAIL

[ "$rc" -eq 0 ] || fail "resume-failed: expected exit 0 (fail-soft), got $rc"
[ -f "$COMPLETE_LOG" ] || fail "resume-failed: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"pull-request"' "$COMPLETE_LOG" ||
  fail "resume-failed: complete call did not report outcome: pull-request ($(cat "$COMPLETE_LOG"))"
if grep -q -- '--resume' "$CLAUDE_ARGS_LOG" 2>/dev/null; then
  fail "resume-failed: claude was passed --resume despite a failed restore ($(cat "$CLAUDE_ARGS_LOG"))"
fi

echo "scenario resume-failed: OK"

# --- Scenario 2: no-deliverable ---------------------------------------------
# The PR-marker lookup gh api call finds nothing, so verify-deliverable.sh's
# own gate fails closed. direct-runner.sh must still POST /complete (with
# the failure outcome, never silently drop it) and, by this script's own
# exit-code design (a non-pull-request outcome exits non-zero so container-
# level supervision can tell success and failure apart without re-parsing
# stdout), exit non-zero itself.
export FAKE_GH_NO_MATCH=1
run_scenario no-deliverable
unset FAKE_GH_NO_MATCH

[ "$rc" -ne 0 ] || fail "no-deliverable: expected a non-zero exit, got 0"
[ -f "$COMPLETE_LOG" ] || fail "no-deliverable: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"no-deliverable"' "$COMPLETE_LOG" ||
  fail "no-deliverable: complete call did not report outcome: no-deliverable ($(cat "$COMPLETE_LOG"))"

echo "scenario no-deliverable: OK"

# --- Scenario 3: brief 401 (expired/invalid run token) ----------------------
# The very first call (GET .../brief) fails closed. direct-runner.sh must
# abort immediately under `set -e` -- no clone, no claude invocation, and
# critically no completion callback at all (there is no run-token-
# authenticated way to report one: `complete` itself needs the same token
# that just failed brief).
export FAKE_BRIEF_FAIL=1
run_scenario brief-401
unset FAKE_BRIEF_FAIL

[ "$rc" -ne 0 ] || fail "brief-401: expected a non-zero exit, got 0"
[ ! -f "$COMPLETE_LOG" ] || fail "brief-401: direct-runner.sh called POST .../complete after a failed brief fetch"

echo "scenario brief-401: OK"

# --- Scenario 4: missing claude token file -----------------------------------
# A missing/unreadable CLAUDE_TOKEN_FILE must fail the run loudly rather
# than silently invoking claude with no credential (which would instead
# fail deep inside the claude CLI with a less legible auth error). Review
# fix (PR #1568): by this point the run is claimed and LCARS_RUN_TOKEN is
# confirmed valid (the earlier /brief call proved it), so this must NOT be
# treated like brief-401 -- report_early_failure's trap means the run still
# gets a completion callback (outcome: no-deliverable) instead of sitting
# claimed and silently stuck for its whole 2h lease.
export FAKE_MISSING_CLAUDE_TOKEN=1
run_scenario missing-claude-token
unset FAKE_MISSING_CLAUDE_TOKEN

[ "$rc" -ne 0 ] || fail "missing-claude-token: expected a non-zero exit, got 0"
[ ! -f "$CLAUDE_ARGS_LOG" ] || fail "missing-claude-token: claude was invoked despite a missing token file"
[ -f "$COMPLETE_LOG" ] || fail "missing-claude-token: direct-runner.sh never called POST .../complete despite a claimed, token-valid run"
grep -q '"outcome":"no-deliverable"' "$COMPLETE_LOG" ||
  fail "missing-claude-token: complete call did not report outcome: no-deliverable ($(cat "$COMPLETE_LOG"))"

echo "scenario missing-claude-token: OK"

# --- Scenario 5: checkout-token call fails ------------------------------------
# The same early-failure trap must cover every abort in the claimed-and-
# token-valid window, not just the claude-token check above -- this is the
# earliest such point (immediately after /brief succeeds). No checkout ever
# happens, so no GIT_CLONE_ARGV_LOG is written either.
export FAKE_CHECKOUT_TOKEN_FAIL=1
run_scenario checkout-token-401
unset FAKE_CHECKOUT_TOKEN_FAIL

[ "$rc" -ne 0 ] || fail "checkout-token-401: expected a non-zero exit, got 0"
[ ! -f "$GIT_CLONE_ARGV_LOG" ] || fail "checkout-token-401: git clone ran despite a failed checkout-token call"
[ -f "$COMPLETE_LOG" ] || fail "checkout-token-401: direct-runner.sh never called POST .../complete despite a claimed, token-valid run"
grep -q '"outcome":"no-deliverable"' "$COMPLETE_LOG" ||
  fail "checkout-token-401: complete call did not report outcome: no-deliverable ($(cat "$COMPLETE_LOG"))"

echo "scenario checkout-token-401: OK"

echo "direct-runner.sh: OK"
