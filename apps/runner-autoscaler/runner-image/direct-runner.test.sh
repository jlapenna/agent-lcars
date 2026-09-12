#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
dockerfile="$here/Dockerfile"

# The image artifact must carry the native helpers that direct-runner uses.
# This is a focused packaging contract: the direct scenarios below exercise
# the copied helper behavior, while these assertions prove the Docker build
# includes it.
grep -Fq '/repo/apps/runner-autoscaler/runner-image/runtime' "$dockerfile" || {
  echo "runner image does not copy the native runtime helpers" >&2
  exit 1
}
grep -Fq '/usr/local/lib/agent-lcars/runtime' "$dockerfile" || {
  echo "runner image does not install the native runtime helpers" >&2
  exit 1
}
# Exported: the fake curl/git/gh/claude binaries below run as separate
# processes (found via PATH, not sourced), so they only see `tmp` if it is
# actually in their environment -- an unexported `tmp` would leave every
# `$tmp/...` reference inside those heredocs resolving to an empty prefix
# once direct-runner.sh execs them for real.
tmp="$(mktemp -d)"
export tmp
trap 'rm -rf "$tmp"' EXIT

# --- Fake baked image tree -------------------------------------------------
# Build the native runtime shape produced by the Dockerfile, including its
# trusted protocol dependency. This proves direct execution without a
# source checkout or a GitHub Actions directory.
baked="$tmp/baked"
mkdir -p "$baked/runtime"
cp -R "$repo_root/apps/runner-autoscaler/runner-image/runtime/." "$baked/runtime/"
mkdir -p "$baked/agents/shared/skills"
cp -R "$repo_root/agents/shared/skills/." "$baked/agents/shared/skills/"

BAKED_RUNTIME_HELPERS_DIR="$baked/runtime"
BAKED_PREPARE_DISPATCH="$baked/runtime/prepare-dispatch.sh"
BAKED_VERIFY_OUTCOME="$baked/runtime/verify-outcome.sh"
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
# Installs curl/git/gh/provider fakes into "$1/bin". Every curl call in
# direct-runner.sh sends its bearer/url/timeouts via `--config -` (stdin),
# never `-H`/argv (to keep a bearer token out of `ps aux`/cmdline),
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
    brief_pipeline=",\"pipeline\":\"${FAKE_PIPELINE:-claude}\""
    if [ "${FAKE_BRIEF_NO_PIPELINE:-}" = "1" ]; then
      brief_pipeline=''
    fi
    if [ "${FAKE_ANCHOR:-work}" = "github" ]; then
      cat <<JSON
{"anchor":{"type":"github","repo":"octo/example","issue":42,"html_url":"https://github.test/octo/example/issues/42"},"work":{"spec":{"title":"GitHub work","description":"Work-projected body","pipeline":"${FAKE_PIPELINE:-claude}","target":{"repo":"octo/example"}}}$brief_pipeline,"mode":"${FAKE_MODE:-implement}","reply":"${FAKE_REPLY:-}","runbook":"${FAKE_RUNBOOK:-}","context":"${FAKE_CONTEXT:-}","attemptId":"g1:octo/example#42/r1","generation":1,"intentId":"octo/example#42/r1"}
JSON
    elif [ "${FAKE_BRIEF_NO_RESUME:-}" = "1" ]; then
      cat <<JSON
{"id":"01DIRECTRUNNERTESTFIXTURE1","spec":{"title":"t","description":"d","pipeline":"${FAKE_PIPELINE:-claude}","target":{"repo":"octo/example"}}$brief_pipeline,"mode":"${FAKE_MODE:-implement}","reply":"${FAKE_REPLY:-}","replyChannel":"${FAKE_REPLY_CHANNEL:-}","replyPrincipal":"${FAKE_REPLY_PRINCIPAL:-}","anchor":{"type":"work","id":"01DIRECTRUNNERTESTFIXTURE1","title":"t","body":"d","target_repo":"octo/example","html_url":"https://lcars.test/work/01DIRECTRUNNERTESTFIXTURE1"},"attemptId":"g1:work:01DIRECTRUNNERTESTFIXTURE1/r1","generation":1,"intentId":"work:01DIRECTRUNNERTESTFIXTURE1/r1"}
JSON
    else
      cat <<JSON
{"id":"01DIRECTRUNNERTESTFIXTURE1","spec":{"title":"t","description":"d","pipeline":"${FAKE_PIPELINE:-claude}","target":{"repo":"octo/example"}}$brief_pipeline,"mode":"${FAKE_MODE:-implement}","reply":"${FAKE_REPLY:-}","replyChannel":"${FAKE_REPLY_CHANNEL:-}","replyPrincipal":"${FAKE_REPLY_PRINCIPAL:-}","anchor":{"type":"work","id":"01DIRECTRUNNERTESTFIXTURE1","title":"t","body":"d","target_repo":"octo/example","html_url":"https://lcars.test/work/01DIRECTRUNNERTESTFIXTURE1"},"attemptId":"g1:work:01DIRECTRUNNERTESTFIXTURE1/r1","generation":1,"intentId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","resume":{"sessionId":"sess_1","transcriptGcsUri":"gs://bucket/runs/x/claude-code/sess_1.jsonl"}}
JSON
    fi
    ;;
  */checkout-token)
    if [ "${FAKE_CHECKOUT_TOKEN_FAIL:-}" = "1" ]; then
      echo "fake curl: simulated checkout-token failure" >&2
      exit 22
    fi
    token_attempt=1
    [ ! -f "$CHECKOUT_TOKEN_REQUEST_LOG" ] || token_attempt=$(( $(cat "$CHECKOUT_TOKEN_REQUEST_LOG") + 1 ))
    echo "$token_attempt" > "$CHECKOUT_TOKEN_REQUEST_LOG"
    checkout_token="$FAKE_TOKEN"
    [ "$token_attempt" -lt 2 ] || checkout_token="${FAKE_REFRESHED_TOKEN:-$FAKE_TOKEN}"
    expires_at="$(date -u -d "+${FAKE_CHECKOUT_TOKEN_TTL_SECONDS:-3600} seconds" +%Y-%m-%dT%H:%M:%SZ)"
    echo "{\"token\":\"$checkout_token\",\"expiresAt\":\"$expires_at\"}"
    ;;
  */codex-auth)
    if printf '%s\n' "$config_body" | grep -qF 'request = "PUT"'; then
      [ -n "$data_binary_file" ] && cat "$data_binary_file" >> "$CODEX_AUTH_PERSIST_LOG"
      echo '{"status":"updated"}'
    else
      attempt=1
      [ ! -f "$CODEX_AUTH_REQUEST_LOG" ] || attempt=$(( $(cat "$CODEX_AUTH_REQUEST_LOG") + 1 ))
      echo "$attempt" > "$CODEX_AUTH_REQUEST_LOG"
      if [ "${FAKE_CODEX_AUTH_TRANSPORT_FAIL:-0}" = 1 ]; then exit 7; fi
      status="${FAKE_CODEX_AUTH_STATUS:-200}"
      if [ "$attempt" -le "${FAKE_CODEX_AUTH_BUSY_COUNT:-0}" ]; then status=409; fi
      if [ "$status" != 200 ]; then
        printf '{"error":"private-body-must-not-be-logged"}\n%s' "$status"
        exit 0
      fi
      auth='{"tokens":{"access":"old"}}'
      auth_b64="$(printf '%s' "$auth" | base64 -w0)"
      auth_sha="$(printf '%s' "$auth" | sha256sum | awk '{print $1}')"
      printf '{"authBase64":"%s","generation":"7","sha256":"%s"}\n200' "$auth_b64" "$auth_sha"
    fi
    ;;
  */heartbeat)
    echo heartbeat >> "$HEARTBEAT_LOG"
    if [ "${FAKE_HEARTBEAT_FAIL:-}" = 1 ]; then
      exit 22
    fi
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
  if [ "${1:-}" = config ] && [ "${2:-}" = --local ] &&
    [ "${3:-}" = credential.helper ] && [ "$#" -eq 4 ] &&
    [ -z "${4:-}" ]; then
    touch ".git/local-helper-chain-reset"
  fi
elif [[ " $* " == *" push "* ]]; then
  if [ -n "${FAKE_GLOBAL_GIT_TOKEN:-}" ] &&
    [ ! -f ".git/local-helper-chain-reset" ]; then
    printf '%s' "$FAKE_GLOBAL_GIT_TOKEN" > "$GIT_PUSH_TOKEN_LOG"
  else
    printf 'protocol=https\nhost=github.com\npath=octo/example.git\n\n' |
      "$RUNNER_TEMP/github-credentials/bin/git-credential-lcars" get |
      sed -n 's/^password=//p' > "$GIT_PUSH_TOKEN_LOG"
  fi
fi
exit 0
FAKE
  chmod +x "$bindir/git"

  cat > "$bindir/gh" <<'FAKE'
#!/usr/bin/env bash
printf '%s' "${GH_TOKEN:-}" > "$GH_INVOCATION_TOKEN_LOG"
if [[ "$*" == *"pulls?state=all"* ]]; then
  if [ "${FAKE_GH_LOOKUP_FAIL:-}" = 1 ]; then
    exit 1
  elif [ -n "${FAKE_GH_MATCH_AFTER_OPENCODE_RUNS:-}" ] &&
    [ -f "${OPENCODE_RUN_COUNT_FILE:-/nonexistent}" ] &&
    [ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -ge "$FAKE_GH_MATCH_AFTER_OPENCODE_RUNS" ]; then
    echo '12'
  elif [ "${FAKE_GH_NO_MATCH:-}" = "1" ]; then
    echo ""
  else
    echo '12'
  fi
  exit 0
fi
if [[ "$*" == *"issues/42/comments"* ]]; then
  if [ "${FAKE_GH_MARKER_COMMENT:-}" = "1" ]; then
    if [[ "$*" == *"--jq"* ]]; then
      case "$*" in
        *'agent-result:v1:park'*)
          [ "${FAKE_GH_MARKER_PARK:-}" = "1" ] && echo '99'
          ;;
        *'agent-result:v1:no-op'*)
          [ "${FAKE_GH_MARKER_NO_OP:-}" = "1" ] && echo '99'
          ;;
        *) echo '99' ;;
      esac
    else
      printf '[{"user":{"type":"Bot"},"body":"<!-- attempt-claim:%s -->"}]\n' "$ATTEMPT_ID"
    fi
  else
    if [[ "$*" == *"--jq"* ]]; then
      echo ''
    else
      echo '[]'
    fi
  fi
  exit 0
fi
if [[ "$*" == *"pulls/42/reviews"* ]]; then
  if [ "${FAKE_GH_MARKER_REVIEW:-}" = "1" ]; then
    if [[ "$*" == *"--jq"* ]]; then
      echo '100'
    else
      printf '[{"user":{"type":"Bot"},"body":"<!-- attempt-claim:%s -->"}]\n' "$ATTEMPT_ID"
    fi
  else
    if [[ "$*" == *"--jq"* ]]; then
      echo ''
    else
      echo '[]'
    fi
  fi
  exit 0
fi
if [[ "$*" == *"issues/42"* ]]; then
  if [ "${FAKE_GITHUB_PR:-}" = "1" ]; then
    echo '{"number":42,"title":"GitHub anchor","body":"Anchor body","html_url":"https://github.test/octo/example/pull/42","state":"open","labels":[],"assignees":[],"pull_request":{}}'
  else
    echo '{"number":42,"title":"GitHub anchor","body":"Anchor body","html_url":"https://github.test/octo/example/issues/42","state":"open","labels":[],"assignees":[]}'
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
printf '%s' "${CLAUDE_CODE_OAUTH_TOKEN:-}|${ACTIONS_RERUN_TOKEN:-}" > "$CLAUDE_ENV_TOKEN_LOG"
if [ -n "${FAKE_CREDENTIAL_USE_AFTER_SLEEP:-}" ]; then
  sleep "$FAKE_CREDENTIAL_USE_AFTER_SLEEP"
  git push
  gh api repos/octo/example
fi
# Opt-in: most scenarios don't care what claude "said", only what it was
# asked and how it exited. Set to exercise direct-runner.sh's final-message
# capture (`--print` piped through `tee`).
if [ -n "${FAKE_CLAUDE_STDOUT:-}" ]; then
  printf '%s' "$FAKE_CLAUDE_STDOUT"
fi
exit 0
FAKE
  chmod +x "$bindir/claude"

  cat > "$bindir/codex" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then
  exit 0
fi
echo "$@" >> "$CODEX_ARGS_LOG"
printf '%s' "${ACTIONS_RERUN_TOKEN:-}" > "$CODEX_ENV_LOG"
# Real codex writes the final message to the file named by
# --output-last-message, not to stdout -- opt-in, mirroring the fake
# claude's own FAKE_CLAUDE_STDOUT convention.
if [ -n "${FAKE_CODEX_LAST_MESSAGE:-}" ]; then
  prev=''
  for arg in "$@"; do
    if [ "$prev" = "--output-last-message" ]; then
      printf '%s' "$FAKE_CODEX_LAST_MESSAGE" > "$arg"
      break
    fi
    prev="$arg"
  done
fi
if [ -n "${FAKE_NATIVE_OUTCOME:-}" ]; then
  [ -n "${ATTEMPT_ID:-}" ] || exit 2
  [ -n "${NATIVE_WORK_OUTCOME_FILE:-}" ] || exit 2
  printf '<!-- agent-result:v1:%s:%s -->\n<!-- attempt-claim:%s -->\n' \
    "$FAKE_NATIVE_OUTCOME" "$ATTEMPT_ID" "$ATTEMPT_ID" > "$NATIVE_WORK_OUTCOME_FILE"
fi
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

cat > "$bindir/opencode" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = run ] && [ "${2:-}" = --help ]; then
  [ "${FAKE_OPENCODE_NO_AUTO:-}" = 1 ] || echo '      --auto         auto-approve permissions'
  exit 0
fi
if [ "${1:-}" = --pure ] && [ "${2:-}" = session ] && [ "${3:-}" = list ]; then
  touch "$tmp/opencode-initialized"
  echo bootstrap >> "${OPENCODE_SEQUENCE_LOG:-/dev/null}"
  if [ "${FAKE_OPENCODE_BOOTSTRAP_FAIL:-}" = 1 ] || [ "${FAKE_OPENCODE_INIT_EXIT:-0}" -ne 0 ]; then exit 1; fi
  if [ "${FAKE_OPENCODE_MALFORMED_SESSIONS:-}" = 1 ]; then echo '{}'; exit 0; fi
  if [ "${FAKE_OPENCODE_EMPTY_BOOTSTRAP:-}" = 1 ] && [ ! -f "${OPENCODE_FAKE_SESSIONS_FILE:-/nonexistent}" ]; then exit 0; fi
  sessions='[]'
  if [ -f "${OPENCODE_FAKE_SESSIONS_FILE:-/nonexistent}" ]; then
    sessions="$(cat "$OPENCODE_FAKE_SESSIONS_FILE")"
  fi
  printf '%s\n' "$sessions"
  exit 0
fi
echo "$@" >> "$OPENCODE_ARGS_LOG"
printf '%s\n' "${OPENCODE_LLM_API_KEY:-}|${GITHUB_TOKEN:-}|${ACTIONS_RERUN_TOKEN:-}|${GITHUB_EVENT_NAME:-}|${MODEL:-}" > "$OPENCODE_ENV_LOG"
echo run >> "${OPENCODE_SEQUENCE_LOG:-/dev/null}"
run_count=1
if [ -f "${OPENCODE_RUN_COUNT_FILE:-/nonexistent}" ]; then
  run_count=$(( $(cat "$OPENCODE_RUN_COUNT_FILE") + 1 ))
fi
echo "$run_count" > "$OPENCODE_RUN_COUNT_FILE"
if [ "${FAKE_OPENCODE_STALE_NO_DELIVERABLE:-}" = 1 ] && [ "$run_count" -eq 1 ]; then
  echo 'NO_DELIVERABLE=1' >> "$RUNTIME_ENV"
fi
if [ "${FAKE_OPENCODE_NATIVE_PARK:-}" = 1 ]; then
  printf '%s\n%s\n' \
    "<!-- agent-result:v1:park:${ATTEMPT_ID} -->" \
    "<!-- attempt-claim:${ATTEMPT_ID} -->" > "$NATIVE_WORK_OUTCOME_FILE"
fi
if [ "${FAKE_OPENCODE_CREATE_AMBIGUOUS_SESSIONS:-}" = 1 ]; then
  printf '[{"id":"ses_new_1","directory":"%s"},{"id":"ses_new_2","directory":"%s"}]\n' "$PWD" "$PWD" > "$OPENCODE_FAKE_SESSIONS_FILE"
elif [ ! -f "$OPENCODE_FAKE_SESSIONS_FILE" ] || [ "$(cat "$OPENCODE_FAKE_SESSIONS_FILE")" = '[]' ]; then
  printf '[{"id":"ses_new_1","directory":"%s"}]\n' "$PWD" > "$OPENCODE_FAKE_SESSIONS_FILE"
fi
if [ -n "${FAKE_OPENCODE_SLEEP_SECONDS:-}" ]; then
  sleep "$FAKE_OPENCODE_SLEEP_SECONDS"
fi
# Opt-in: proves direct-runner.sh no longer scrapes OpenCode's own formatted
# stdout for the final message (issue #1784) -- opencode-last-message sets
# this to something distinct from FAKE_OPENCODE_LAST_MESSAGE and asserts the
# completion payload carries the latter, never this text.
if [ -n "${FAKE_OPENCODE_STDOUT:-}" ]; then
  printf '%s' "$FAKE_OPENCODE_STDOUT"
fi
exit "${FAKE_OPENCODE_EXIT_CODE:-0}"
FAKE
  chmod +x "$bindir/opencode"

  cat > "$bindir/timeout" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RUNNER_TEMP/timeout-args.log"
if [ -n "${TIMEOUT_ARGS_LOG:-}" ] && [ "$TIMEOUT_ARGS_LOG" != "$RUNNER_TEMP/timeout-args.log" ]; then
  printf '%s\n' "$*" >> "$TIMEOUT_ARGS_LOG"
fi
exec /usr/bin/timeout "$@"
FAKE
  chmod +x "$bindir/timeout"

  # Fake node helper for the direct-runner resume test:
  # records its argv (proving direct-runner.sh's `runner resume` call site
  # passes the right session id/transcript uri/cwd) and either prints a
  # fake resumed local path or, when FAKE_RESUME_FAIL is set, fails. A
  # successful command can also return an empty path, which is equally
  # invalid for the requested-resume contract.
cat > "$bindir/node" <<'FAKE'
#!/usr/bin/env bash
echo "$@" >> "$NODE_ARGS_LOG"
if [ "${2:-}" = runner ] && [ "${3:-}" = sidecar ]; then
  echo sidecar >> "${OPENCODE_SEQUENCE_LOG:-/dev/null}"
  if [ ! -f "$tmp/opencode-initialized" ]; then
    touch "$tmp/opencode-startup-race"
  fi
fi
# Stands in for the real sidecar's `runner finalize` subcommand (issue
# #1784): when direct-runner.sh's sidecar-lifecycle.sh threads
# --opencode-last-message-file through, this simulates the sidecar writing
# the extracted final message there -- and, before writing, records whether
# the file already existed. A pre-existing file would mean something else
# (a leftover `tee`) created it first, which the opencode-last-message
# scenario asserts against. $1 is the invoked script path (real `node
# <script> <args>` shape), so the subcommand pair is $2/$3, not $1/$2.
if [ "${2:-}" = runner ] && [ "${3:-}" = finalize ]; then
  prev=""
  last_message_path=""
  for arg in "$@"; do
    if [ "$prev" = "--opencode-last-message-file" ]; then
      last_message_path="$arg"
    fi
    prev="$arg"
  done
  if [ -n "$last_message_path" ]; then
    if [ -e "$last_message_path" ]; then
      echo present > "${OPENCODE_LAST_MESSAGE_PRECHECK_LOG:-/dev/null}"
    else
      echo absent > "${OPENCODE_LAST_MESSAGE_PRECHECK_LOG:-/dev/null}"
    fi
    if [ -n "${FAKE_OPENCODE_LAST_MESSAGE:-}" ]; then
      printf '%s' "$FAKE_OPENCODE_LAST_MESSAGE" > "$last_message_path"
    fi
  fi
  exit 0
fi
if [ "${FAKE_RESUME_FAIL:-}" = "1" ]; then
  exit 1
fi
if [ "${FAKE_RESUME_EMPTY:-}" = "1" ]; then
  exit 0
fi
echo "/fake/claude/projects/-fake-cwd/sess_1.jsonl"
FAKE
  chmod +x "$bindir/node"

  # The production runner has no RUNTIME_HELPERS_DIR in its environment. For
  # the one default-path scenario, intercept only the two image-runtime
  # helper entrypoints: assert the direct runner exported its literal image
  # default into this child process, then dispatch to the equivalent fake
  # baked helper. All other bash calls execute normally. This avoids writing
  # to /usr/local while still exercising the production default without
  # pre-exporting RUNTIME_HELPERS_DIR from the fixture.
  cat > "$bindir/bash" <<'FAKE'
#!/bin/bash
runtime_root='/usr/local/lib/agent-lcars/runtime'
if [ "${FAKE_PRODUCTION_RUNTIME_DEFAULT:-}" = 1 ] && {
  [ "${1:-}" = "$runtime_root/prepare-dispatch.sh" ] ||
    [ "${1:-}" = "$runtime_root/verify-outcome.sh" ]
}; then
  [ "${RUNTIME_HELPERS_DIR:-}" = "$runtime_root" ] || {
    echo "fake bash: direct runner did not export production RUNTIME_HELPERS_DIR" >&2
    exit 1
  }
  printf '%s\n' "$1" >> "$RUNTIME_HELPERS_DEFAULT_LOG"
  RUNTIME_HELPERS_DIR="$FAKE_BAKED_RUNTIME_HELPERS_DIR" exec /bin/bash "$FAKE_BAKED_RUNTIME_HELPERS_DIR/${1##*/}"
fi
exec /bin/bash "$@"
FAKE
  chmod +x "$bindir/bash"
}

run_scenario() {
  name="$1"
  rm -f "$tmp/opencode-initialized" "$tmp/opencode-startup-race"
  export FAKE_PIPELINE="${2:-claude}"
  # A QueueExecutor container is not a GitHub Actions worker.  CI itself
  # exports this event context, so clear it explicitly before each fixture to
  # prove the direct adapter neither depends on nor invents an Actions event.
  unset GITHUB_EVENT_NAME GITHUB_EVENT_PATH
  dir="$tmp/$name"
  mkdir -p "$dir/bin"
  make_fake_bins "$dir/bin"

  export PATH="$dir/bin:$PATH"
  export LCARS_RUN_ID="work:01DIRECTRUNNERTESTFIXTURE1/r1"
  export LCARS_RUN_TOKEN="test-token"
  if [ "${FAKE_MISSING_CONSOLE_URL:-}" = "1" ]; then
    unset LCARS_CONSOLE_URL
  else
    export LCARS_CONSOLE_URL="https://lcars.test"
  fi
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
  export CODEX_ENV_LOG="$dir/codex-env.log"
  export CODEX_SESSIONS_DIR_LOG="$dir/codex-sessions-dir.log"
  export CODEX_AUTH_PERSIST_LOG="$dir/codex-auth-persist.log"
  export CODEX_AUTH_REQUEST_LOG="$dir/codex-auth-requests.log"
  export CHECKOUT_TOKEN_REQUEST_LOG="$dir/checkout-token-requests.log"
  export GIT_PUSH_TOKEN_LOG="$dir/git-push-token.log"
  export GH_INVOCATION_TOKEN_LOG="$dir/gh-invocation-token.log"
  export HEARTBEAT_LOG="$dir/heartbeats.log"
  export OPENCODE_ARGS_LOG="$dir/opencode-args.log"
  export OPENCODE_ENV_LOG="$dir/opencode-env.log"
  export OPENCODE_LAST_MESSAGE_PRECHECK_LOG="$dir/opencode-last-message-precheck.log"
  export OPENCODE_SEQUENCE_LOG="$dir/opencode-sequence.log"
  export OPENCODE_FAKE_SESSIONS_FILE="$dir/opencode-sessions.json"
  export OPENCODE_RUN_COUNT_FILE="$dir/opencode-run-count"
  export TIMEOUT_ARGS_LOG="$dir/timeout-args.log"
  export RUNTIME_HELPERS_DEFAULT_LOG="$dir/runtime-helpers-default.log"

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

  printf '%s' 'fake-opencode-llm-key' > "$dir/opencode-llm-api-key"
  export OPENCODE_TOKEN_FILE="$dir/opencode-llm-api-key"
  export OPENCODE_BIN="$dir/bin/opencode"
  # Exercise the adapter's production default instead of masking it here.
  unset OPENCODE_MODEL

  # Bounds the background heartbeat loop's orphaned-sleep lifetime to
  # ~1 second instead of the production 300s default: fake `claude` returns
  # near-instantly, so direct-runner.sh kills (without waiting on) the loop
  # well before its first tick either way, but a short interval keeps a
  # not-yet-reaped `sleep` process from lingering past this test's own exit.
  export HEARTBEAT_INTERVAL_SECONDS=1

  # Point every helper at the fake baked tree (not the live repo), so this
  # test exercises the same native layout the Dockerfile produces. The
  # production-default case deliberately leaves the runtime helper variables
  # absent and lets the fake `bash` above prove the direct runner exports its
  # literal image default before translating it to this fixture tree.
  if [ "${FAKE_PRODUCTION_RUNTIME_DEFAULT:-}" = 1 ]; then
    unset RUNTIME_HELPERS_DIR PREPARE_DISPATCH VERIFY_OUTCOME
    export FAKE_BAKED_RUNTIME_HELPERS_DIR="$BAKED_RUNTIME_HELPERS_DIR"
  else
    export RUNTIME_HELPERS_DIR="$BAKED_RUNTIME_HELPERS_DIR"
    export PREPARE_DISPATCH="$BAKED_PREPARE_DISPATCH"
    export VERIFY_OUTCOME="$BAKED_VERIFY_OUTCOME"
  fi
  export SIDECAR_LIFECYCLE="$BAKED_SIDECAR_LIFECYCLE"

  set +e
  scenario_log="$dir/direct-runner.log"
  if [ "${FAKE_CANCEL_CODEX_WAIT:-0}" = 1 ]; then
    timeout --signal=TERM --kill-after=2s 3s /bin/bash "$here/direct-runner.sh" >"$scenario_log" 2>&1
  else
    /bin/bash "$here/direct-runner.sh" >"$scenario_log" 2>&1
  fi
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

# Direct mode configures its own commit identity. Assert it landed in the
# checkout's own git config, not just that direct-runner.sh ran the command.
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

# mode:implement with no reply must keep the generic dispatch prompt: a
# resumed round is not automatically a reply round.
if grep -q 'A human replied on' "$CLAUDE_ARGS_LOG" 2>/dev/null; then
  fail "happy path: reply-round framing leaked into a dispatch with no reply ($(cat "$CLAUDE_ARGS_LOG"))"
fi

# Production starts without RUNTIME_HELPERS_DIR in the QueueExecutor
# container. Its default must be exported to prepare/verify helpers; the
# fixture's fake bash records those exact image paths before running the
# equivalent baked helper tree.
FAKE_PRODUCTION_RUNTIME_DEFAULT=1 run_scenario production-runtime-default

[ "$rc" -eq 0 ] || fail "production runtime default: expected exit 0, got $rc"
grep -Fxq '/usr/local/lib/agent-lcars/runtime/prepare-dispatch.sh' "$RUNTIME_HELPERS_DEFAULT_LOG" ||
  fail "production runtime default: prepare helper did not receive exported image default"
grep -Fxq '/usr/local/lib/agent-lcars/runtime/verify-outcome.sh' "$RUNTIME_HELPERS_DEFAULT_LOG" ||
  fail "production runtime default: verify helper did not receive exported image default"

# The credential-delivery fix under test: CLAUDE_TOKEN_FILE's contents must
# reach claude's own process environment as CLAUDE_CODE_OAUTH_TOKEN.
[ -f "$CLAUDE_ENV_TOKEN_LOG" ] || fail "happy path: claude was never invoked with an env to record"
if [ "$(cat "$CLAUDE_ENV_TOKEN_LOG")" != "$FAKE_CLAUDE_OAUTH_TOKEN|" ]; then
  fail "happy path: Claude did not receive its credential or inherited a static GitHub token (got $(cat "$CLAUDE_ENV_TOKEN_LOG"))"
fi

echo "scenario happy-path: OK"

# A provider process cannot observe parent-shell environment mutations. Keep it
# alive across a forced credential rotation, then prove its later git and gh
# subprocesses independently read the refreshed file-backed credential.
export FAKE_REFRESHED_TOKEN='fake-refreshed-checkout-token-uvw456'
export FAKE_CHECKOUT_TOKEN_TTL_SECONDS=6
export CHECKOUT_TOKEN_REFRESH_MARGIN_SECONDS=4
export CHECKOUT_TOKEN_REFRESH_RETRY_SECONDS=1
export FAKE_CREDENTIAL_USE_AFTER_SLEEP=3
export FAKE_GLOBAL_GIT_TOKEN='stale-token-from-global-helper'
run_scenario renewable-checkout-token
unset FAKE_REFRESHED_TOKEN FAKE_CHECKOUT_TOKEN_TTL_SECONDS \
  CHECKOUT_TOKEN_REFRESH_MARGIN_SECONDS CHECKOUT_TOKEN_REFRESH_RETRY_SECONDS \
  FAKE_CREDENTIAL_USE_AFTER_SLEEP FAKE_GLOBAL_GIT_TOKEN
[ "$(cat "$CHECKOUT_TOKEN_REQUEST_LOG")" -ge 2 ] ||
  fail 'renewable checkout token was not refreshed'
[ "$(cat "$GIT_PUSH_TOKEN_LOG")" = 'fake-refreshed-checkout-token-uvw456' ] ||
  fail 'git push did not read the refreshed checkout token'
[ "$(cat "$GH_INVOCATION_TOKEN_LOG")" = 'fake-refreshed-checkout-token-uvw456' ] ||
  fail 'gh did not read the refreshed checkout token'
hostile_credential="$(printf 'protocol=https\nhost=github.com.attacker.example\npath=octo/example.git\n\n' |
  "$RUNNER_TEMP/github-credentials/bin/git-credential-lcars" get)"
[ -z "$hostile_credential" ] || fail 'git credential helper disclosed a token to a non-GitHub host'
wrong_repo_credential="$(printf 'protocol=https\nhost=github.com\npath=octo/other.git\n\n' |
  "$RUNNER_TEMP/github-credentials/bin/git-credential-lcars" get)"
[ -z "$wrong_repo_credential" ] || fail 'git credential helper disclosed a token to another repository'
echo "scenario renewable-checkout-token: OK"

# --- Scenario 1a: Codex provider dispatch, resume, and the auth broker ------
# Codex must run without the Claude host-token mount, restore only through
# the run-token broker, and persist the changed auth.json with the exact
# restored generation/hash. The default brief's resume object (session
# sess_1) must now resume the same Codex thread: runner resume gets
# --agent codex and --codex-home, and codex itself gets `exec resume
# sess_1`, keeping --json and the bypass flag exactly as before.
export FAKE_MISSING_CLAUDE_TOKEN=1
run_scenario codex-happy codex
unset FAKE_MISSING_CLAUDE_TOKEN

[ "$rc" -eq 0 ] || fail "codex happy path: expected exit 0, got $rc"
[ -s "$CODEX_ARGS_LOG" ] || fail "codex happy path: codex was not invoked"
[ ! -s "$CODEX_ENV_LOG" ] ||
  fail "codex happy path: Codex inherited a static GitHub token ($(cat "$CODEX_ENV_LOG"))"
grep -q -- 'exec resume sess_1 --json --dangerously-bypass-approvals-and-sandbox' "$CODEX_ARGS_LOG" ||
  fail "codex happy path: wrong invocation ($(cat "$CODEX_ARGS_LOG"))"
if grep -q -- '--ephemeral' "$CODEX_ARGS_LOG"; then
  fail "codex happy path: ephemeral execution suppresses telemetry sessions"
fi
[ ! -f "$CLAUDE_ARGS_LOG" ] || fail "codex happy path: claude was invoked"
[ -s "$CODEX_SESSIONS_DIR_LOG" ] || fail "codex happy path: fake Codex did not receive its session root"
codex_sessions_dir="$(cat "$CODEX_SESSIONS_DIR_LOG")"
[ -f "$NODE_ARGS_LOG" ] || fail "codex happy path: sidecar never invoked node"
grep -q -- 'runner resume' "$NODE_ARGS_LOG" ||
  fail "codex happy path: runner resume was not invoked despite a resume brief ($(cat "$NODE_ARGS_LOG"))"
grep -q -- '--agent codex' "$NODE_ARGS_LOG" ||
  fail "codex happy path: runner resume was not passed --agent codex ($(cat "$NODE_ARGS_LOG"))"
grep -q -- "--codex-home $LCARS_CODEX_VOLATILE_DIR" "$NODE_ARGS_LOG" ||
  fail "codex happy path: runner resume was not passed --codex-home ($(cat "$NODE_ARGS_LOG"))"
grep -q -- '--session-id sess_1' "$NODE_ARGS_LOG" ||
  fail "codex happy path: runner resume was not passed the session id ($(cat "$NODE_ARGS_LOG"))"
grep -q -- '--transcript-uri gs://bucket/runs/x/claude-code/sess_1.jsonl' "$NODE_ARGS_LOG" ||
  fail "codex happy path: runner resume was not passed the transcript uri ($(cat "$NODE_ARGS_LOG"))"
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

# --- Scenario 1a-i: no resume in the brief keeps the fresh codex path -------
# Regression pin: a brief with no `resume` field must leave Codex's dispatch
# byte-identical to today -- no `runner resume` invocation, and codex gets
# plain `exec`, never `resume`.
export FAKE_BRIEF_NO_RESUME=1
run_scenario codex-no-resume codex
unset FAKE_BRIEF_NO_RESUME

[ "$rc" -eq 0 ] || fail "codex no-resume: expected exit 0, got $rc"
if grep -q -- 'runner resume' "$NODE_ARGS_LOG" 2>/dev/null; then
  fail "codex no-resume: runner resume was invoked despite no resume field in the brief ($(cat "$NODE_ARGS_LOG"))"
fi
grep -q -- 'exec --json --dangerously-bypass-approvals-and-sandbox' "$CODEX_ARGS_LOG" ||
  fail "codex no-resume: codex was not invoked with a fresh exec ($(cat "$CODEX_ARGS_LOG"))"
if grep -q -- 'exec resume' "$CODEX_ARGS_LOG"; then
  fail "codex no-resume: codex received a resume subcommand despite no resume field in the brief ($(cat "$CODEX_ARGS_LOG"))"
fi

echo "scenario codex-no-resume: OK"

# --- Scenario 1a-ii: a requested Codex restore that fails is fatal ----------
# A resume request that cannot be restored must never silently become a
# fresh Codex thread -- same fail-closed contract as Claude's resume-failed
# scenario above.
export FAKE_RESUME_FAIL=1
run_scenario codex-resume-failed codex
unset FAKE_RESUME_FAIL

[ "$rc" -ne 0 ] || fail "codex resume-failed: expected a restore failure"
[ -f "$COMPLETE_LOG" ] || fail "codex resume-failed: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"runner-failed"' "$COMPLETE_LOG" ||
  fail "codex resume-failed: complete call did not report runner-failed ($(cat "$COMPLETE_LOG"))"
[ ! -f "$CODEX_ARGS_LOG" ] ||
  fail "codex resume-failed: codex started after a failed restore ($(cat "$CODEX_ARGS_LOG"))"

echo "scenario codex-resume-failed: OK"

# --- Scenario 1a-iii: the agent's final message reaches /complete -----------
# Real codex writes its last message to the file named by
# --output-last-message, not to stdout; direct-runner.sh must read that file
# into the same `message` field Claude's stdout capture already produces.
export FAKE_CODEX_LAST_MESSAGE='PARK waiting on the maintainer'
run_scenario codex-last-message codex
unset FAKE_CODEX_LAST_MESSAGE

[ "$rc" -eq 0 ] || fail "codex last-message: expected exit 0, got $rc"
grep -q -- '--output-last-message' "$CODEX_ARGS_LOG" ||
  fail "codex last-message: codex was not invoked with --output-last-message ($(cat "$CODEX_ARGS_LOG"))"
jq -e '.message | contains("PARK waiting on the maintainer")' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "codex last-message: complete payload did not carry the captured message ($(cat "$COMPLETE_LOG"))"

echo "scenario codex-last-message: OK"

# A positive #1192 refresh-failure signature must reach the broker as the
# narrow enum that makes persistence an authoritative no-write. The agent run
# itself still fails and reports no-deliverable.
export FAKE_CODEX_BURNED=1 FAKE_GH_NO_MATCH=1
run_scenario codex-burned codex
unset FAKE_CODEX_BURNED FAKE_GH_NO_MATCH

[ "$rc" -ne 0 ] || fail "codex burned auth: expected a non-zero exit"
jq -e '.authFailure == "refresh-token-reused"' "$CODEX_AUTH_PERSIST_LOG" >/dev/null ||
  fail "codex burned auth: broker payload did not carry the exact failure enum ($(cat "$CODEX_AUTH_PERSIST_LOG"))"
grep -q '"outcome":"agent-failed"' "$COMPLETE_LOG" ||
  fail "codex burned auth: completion did not report agent-failed ($(cat "$COMPLETE_LOG"))"

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
export FAKE_CODEX_STDERR_BURNED=1 FAKE_GH_NO_MATCH=1
run_scenario codex-burned-stderr codex
unset FAKE_CODEX_STDERR_BURNED FAKE_GH_NO_MATCH

[ "$rc" -ne 0 ] || fail "codex stderr burned auth: expected a non-zero exit"
jq -e '.authFailure == "access-token-refresh-failed"' "$CODEX_AUTH_PERSIST_LOG" >/dev/null ||
  fail "codex stderr burned auth: origin diagnostic was not classified ($(cat "$CODEX_AUTH_PERSIST_LOG"))"
if find "$LCARS_CODEX_VOLATILE_DIR" -mindepth 1 -print -quit | grep -q .; then
  fail "codex stderr burned auth: volatile auth/payload files survived failure exit"
fi

echo "scenario codex-burned-stderr: OK"

# OpenCode follows the same queue bootstrap and completion path. Its provider
# key is read only from the adapter's file mount by OpenCode's baked config;
# it must never enter the CLI environment, where agent tool shells inherit it.
# Deliberately seed the direct runner's inherited environment so this proves
# the adapter actively scrubs it rather than merely starting from a clean
# fixture.  The value is a test sentinel, never a credential.
#
# The default brief's resume object (session sess_1) must now resume the
# same OpenCode session (resumable-conversations plan 4): runner resume
# gets --agent opencode, and opencode itself gets --session sess_1, keeping
# --model and --auto exactly as before.
export OPENCODE_LLM_API_KEY='ambient-opencode-key-must-not-reach-agent'
run_scenario opencode-happy opencode
unset OPENCODE_LLM_API_KEY
[ "$rc" -eq 0 ] || fail "opencode happy path: expected exit 0, got $rc"
[ -s "$OPENCODE_ARGS_LOG" ] || fail "opencode happy path: OpenCode was not invoked"
grep -q -- 'run --model homelab/default --session sess_1 --auto' "$OPENCODE_ARGS_LOG" ||
  fail "opencode happy path: wrong invocation ($(cat "$OPENCODE_ARGS_LOG"))"
[ "$(cat "$OPENCODE_ENV_LOG")" = "||||" ] ||
  fail "opencode happy path: OpenCode inherited the LiteLLM key in its environment ($(cat "$OPENCODE_ENV_LOG"))"
[ ! -f "$CLAUDE_ARGS_LOG" ] || fail "opencode happy path: claude was invoked"
[ ! -f "$CODEX_ARGS_LOG" ] || fail "opencode happy path: codex was invoked"
grep -q '"outcome":"pull-request"' "$COMPLETE_LOG" ||
  fail "opencode happy path: completion was not a pull request ($(cat "$COMPLETE_LOG"))"
[ -f "$NODE_ARGS_LOG" ] || fail "opencode happy path: sidecar never invoked node"
grep -q -- 'runner resume' "$NODE_ARGS_LOG" ||
  fail "opencode happy path: runner resume was not invoked despite a resume brief ($(cat "$NODE_ARGS_LOG"))"
grep -q -- '--agent opencode' "$NODE_ARGS_LOG" ||
  fail "opencode happy path: runner resume was not passed --agent opencode ($(cat "$NODE_ARGS_LOG"))"
grep -q -- '--session-id sess_1' "$NODE_ARGS_LOG" ||
  fail "opencode happy path: runner resume was not passed the session id ($(cat "$NODE_ARGS_LOG"))"
grep -q -- '--transcript-uri gs://bucket/runs/x/claude-code/sess_1.jsonl' "$NODE_ARGS_LOG" ||
  fail "opencode happy path: runner resume was not passed the transcript uri ($(cat "$NODE_ARGS_LOG"))"

echo "scenario opencode-happy: OK"

first_opencode_step="$(head -n1 "$OPENCODE_SEQUENCE_LOG")"
[ "$first_opencode_step" = bootstrap ] ||
  fail "opencode bootstrap: sidecar/provider touched the store before synchronous initialization ($(cat "$OPENCODE_SEQUENCE_LOG"))"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode verified deliverable: provider was continued despite exact verifier success"

echo "scenario opencode-bootstrap-order: OK"

# OpenCode 1.18.30 returns successful empty stdout for a fresh pure session
# listing. That is a valid empty baseline, while non-empty malformed JSON still
# fails closed.
export FAKE_BRIEF_NO_RESUME=1 FAKE_OPENCODE_EMPTY_BOOTSTRAP=1
run_scenario opencode-empty-bootstrap opencode
unset FAKE_BRIEF_NO_RESUME FAKE_OPENCODE_EMPTY_BOOTSTRAP
[ "$rc" -eq 0 ] || fail "opencode empty bootstrap: successful empty listing blocked the run"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode empty bootstrap: provider did not run exactly once"

echo "scenario opencode-empty-bootstrap: OK"

# An exit-zero fresh run with completed verifier lookups but no artifact gets
# exactly one continuation in the one newly-created workspace session. The
# fake verifier begins succeeding only after that second provider invocation.
export FAKE_BRIEF_NO_RESUME=1
export FAKE_GH_NO_MATCH=1
export FAKE_GH_MATCH_AFTER_OPENCODE_RUNS=2
export FAKE_OPENCODE_SLEEP_SECONDS=1
export OPENCODE_TIMEOUT_SECONDS=5
run_scenario opencode-premature-stop opencode
unset FAKE_BRIEF_NO_RESUME FAKE_GH_NO_MATCH FAKE_GH_MATCH_AFTER_OPENCODE_RUNS
unset FAKE_OPENCODE_SLEEP_SECONDS OPENCODE_TIMEOUT_SECONDS

[ "$rc" -eq 0 ] || fail "opencode premature stop: continuation did not produce verified completion"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 2 ] ||
  fail "opencode premature stop: expected exactly two total provider rounds"
grep -q -- 'run --model homelab/default --session ses_new_1 --auto Continue the same authorized task' "$OPENCODE_ARGS_LOG" ||
  fail "opencode premature stop: second round did not preserve the discovered session ($(cat "$OPENCODE_ARGS_LOG"))"
mapfile -t opencode_run_timeouts < <(grep 'opencode.* run ' "$TIMEOUT_ARGS_LOG" | sed -nE 's/.* ([0-9]+)s .*opencode.*/\1/p')
[ "${#opencode_run_timeouts[@]}" -eq 2 ] ||
  fail "opencode premature stop: did not record two bounded provider rounds ($(cat "$TIMEOUT_ARGS_LOG"))"
[ "${opencode_run_timeouts[1]}" -lt "${opencode_run_timeouts[0]}" ] ||
  fail "opencode premature stop: continuation reset the provider time budget ($(cat "$TIMEOUT_ARGS_LOG"))"

echo "scenario opencode-premature-stop: OK"

# A continuation is a new grant of execution. If the run was cancelled or
# lost its lease while the first round was active, its authenticated heartbeat
# is refused and the provider must not receive the second round.
export FAKE_BRIEF_NO_RESUME=1 FAKE_GH_NO_MATCH=1 FAKE_GH_MATCH_AFTER_OPENCODE_RUNS=2
export FAKE_HEARTBEAT_FAIL=1
run_scenario opencode-continuation-heartbeat-refused opencode
unset FAKE_BRIEF_NO_RESUME FAKE_GH_NO_MATCH FAKE_GH_MATCH_AFTER_OPENCODE_RUNS
unset FAKE_HEARTBEAT_FAIL
[ "$rc" -eq 1 ] || fail "opencode heartbeat refused: expected terminal no-deliverable"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode heartbeat refused: provider continued after authorization was rejected"

echo "scenario opencode-continuation-heartbeat-refused: OK"

# A resumed run already has the authoritative session id; continuation reuses
# it instead of selecting a different session from the store.
export FAKE_GH_NO_MATCH=1 FAKE_GH_MATCH_AFTER_OPENCODE_RUNS=2
run_scenario opencode-resumed-premature-stop opencode
unset FAKE_GH_NO_MATCH FAKE_GH_MATCH_AFTER_OPENCODE_RUNS
[ "$rc" -eq 0 ] || fail "opencode resumed premature stop: continuation failed"
[ "$(grep -c -- 'run --model.*--session sess_1' "$OPENCODE_ARGS_LOG")" -eq 2 ] ||
  fail "opencode resumed premature stop: both rounds did not preserve sess_1 ($(cat "$OPENCODE_ARGS_LOG"))"

echo "scenario opencode-resumed-premature-stop: OK"

# Multiple new workspace sessions make ownership ambiguous. Do not guess which
# conversation to continue.
export FAKE_BRIEF_NO_RESUME=1 FAKE_GH_NO_MATCH=1 FAKE_OPENCODE_CREATE_AMBIGUOUS_SESSIONS=1
run_scenario opencode-ambiguous-session opencode
unset FAKE_BRIEF_NO_RESUME FAKE_GH_NO_MATCH FAKE_OPENCODE_CREATE_AMBIGUOUS_SESSIONS
[ "$rc" -eq 1 ] || fail "opencode ambiguous session: expected terminal no-deliverable"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode ambiguous session: provider continued without one unambiguous session"

echo "scenario opencode-ambiguous-session: OK"

# A verifier lookup failure is distinct from a completed no-deliverable check
# and must not cause another provider invocation.
export FAKE_BRIEF_NO_RESUME=1 FAKE_GH_LOOKUP_FAIL=1
run_scenario opencode-verifier-lookup-failure opencode
unset FAKE_BRIEF_NO_RESUME FAKE_GH_LOOKUP_FAIL
[ "$rc" -eq 1 ] || fail "opencode verifier lookup failure: expected terminal no-deliverable"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode verifier lookup failure: provider retried after an inconclusive verifier"

echo "scenario opencode-verifier-lookup-failure: OK"

# A stale marker in the shared prepare environment may have come from an
# agent-invoked verifier. A current lookup failure must remain inconclusive;
# only the dedicated, freshly-empty probe environment can authorize recovery.
export FAKE_BRIEF_NO_RESUME=1 FAKE_GH_LOOKUP_FAIL=1
export FAKE_OPENCODE_STALE_NO_DELIVERABLE=1
run_scenario opencode-stale-marker-lookup-failure opencode
unset FAKE_BRIEF_NO_RESUME FAKE_GH_LOOKUP_FAIL
unset FAKE_OPENCODE_STALE_NO_DELIVERABLE
[ "$rc" -eq 1 ] || fail "opencode stale marker: expected terminal no-deliverable"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode stale marker: old shared verifier result authorized continuation"

echo "scenario opencode-stale-marker-lookup-failure: OK"

# Native structured park evidence is already a terminal handoff. It suppresses
# continuation even though the GitHub verifier has no native comment to find.
export FAKE_BRIEF_NO_RESUME=1 FAKE_GH_NO_MATCH=1 FAKE_OPENCODE_NATIVE_PARK=1
run_scenario opencode-native-park-no-continuation opencode
unset FAKE_BRIEF_NO_RESUME FAKE_GH_NO_MATCH FAKE_OPENCODE_NATIVE_PARK
[ "$rc" -eq 0 ] || fail "opencode native park: expected structured terminal success"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode native park: provider continued after structured park"
grep -q '"outcome":"park"' "$COMPLETE_LOG" ||
  fail "opencode native park: completion was not park ($(cat "$COMPLETE_LOG"))"

echo "scenario opencode-native-park-no-continuation: OK"

# A GitHub structured no-op is an exact-marker deliverable and suppresses the
# recovery round just like a park.
export FAKE_ANCHOR=github FAKE_BRIEF_NO_RESUME=1 FAKE_GH_NO_MATCH=1
export FAKE_GH_MARKER_COMMENT=1 FAKE_GH_MARKER_NO_OP=1
run_scenario opencode-github-no-op-no-continuation opencode
unset FAKE_ANCHOR FAKE_BRIEF_NO_RESUME FAKE_GH_NO_MATCH
unset FAKE_GH_MARKER_COMMENT FAKE_GH_MARKER_NO_OP
[ "$rc" -eq 0 ] || fail "opencode GitHub no-op: expected structured terminal success"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode GitHub no-op: provider continued after structured no-op"
grep -q '"outcome":"no-op"' "$COMPLETE_LOG" ||
  fail "opencode GitHub no-op: completion was not no-op ($(cat "$COMPLETE_LOG"))"

echo "scenario opencode-github-no-op-no-continuation: OK"

# A failed bounded initialization reports immediately and never starts the
# telemetry sidecar or an inference-bearing provider round.
export FAKE_OPENCODE_BOOTSTRAP_FAIL=1
run_scenario opencode-bootstrap-failed opencode
unset FAKE_OPENCODE_BOOTSTRAP_FAIL
[ "$rc" -ne 0 ] || fail "opencode bootstrap failed: expected non-zero exit"
[ -f "$COMPLETE_LOG" ] || fail "opencode bootstrap failed: missing completion report"
[ ! -f "$OPENCODE_RUN_COUNT_FILE" ] ||
  fail "opencode bootstrap failed: provider run started after initialization failure"
if grep -q -- 'runner sidecar' "$NODE_ARGS_LOG" 2>/dev/null; then
  fail "opencode bootstrap failed: telemetry sidecar started before initialization completed"
fi

echo "scenario opencode-bootstrap-failed: OK"

# QueueExecutor does not manufacture a GitHub Actions event.  Its OpenCode
# adapter must therefore use the ordinary headless CLI, not `github run`,
# whose action-only event parser rejects an unset GITHUB_EVENT_NAME.
if grep -q -- 'github run' "$OPENCODE_ARGS_LOG"; then
  fail "opencode happy path: invoked the GitHub Actions-only entrypoint ($(cat "$OPENCODE_ARGS_LOG"))"
fi

# --- Scenario: the final message comes from the sidecar's structured export,
# not scraped terminal output (issue #1784) ---------------------------------
# `opencode run`'s own stdout is formatted progress, not a final message;
# the sidecar's `finalize` pass now extracts the real closing turn from its
# own structured export and writes it to the well-known file
# direct-runner.sh points LAST_MESSAGE_FILE at. FAKE_OPENCODE_STDOUT and
# FAKE_OPENCODE_LAST_MESSAGE are deliberately different strings so the
# completion payload's message can only match one of them.
#
# The precheck log also proves the `tee` is actually gone: if it were still
# piping opencode's stdout into that file, the file would already exist by
# the time finalize's fake `node` writes to it.
export FAKE_OPENCODE_STDOUT='some formatted progress line, not a final message'
export FAKE_OPENCODE_LAST_MESSAGE='the real closing turn from the sidecar export'
run_scenario opencode-last-message opencode
unset FAKE_OPENCODE_STDOUT FAKE_OPENCODE_LAST_MESSAGE

[ "$rc" -eq 0 ] || fail "opencode last-message: expected exit 0, got $rc"
[ "$(cat "$OPENCODE_LAST_MESSAGE_PRECHECK_LOG" 2>/dev/null)" = "absent" ] ||
  fail "opencode last-message: the well-known message file already existed before finalize wrote it (tee not removed?)"
jq -e '.message == "the real closing turn from the sidecar export"' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "opencode last-message: complete payload did not carry the sidecar-extracted message ($(cat "$COMPLETE_LOG"))"

echo "scenario opencode-last-message: OK"

# --- Scenario: exit code correctness once the pipe is gone (issue #1784) ---
# `opencode run` no longer runs inside a pipe (`| tee ...`), so its exit
# code must come straight from `$?`, not `${PIPESTATUS[0]}`. A distinctive
# non-zero exit here must still classify the run as no-deliverable -- if a
# stray pipe stage were reintroduced downstream of a naive `$?` switch, its
# own (successful) exit status would silently mask this failure instead.
export FAKE_OPENCODE_EXIT_CODE=5 FAKE_GH_NO_MATCH=1
run_scenario opencode-exit-nonzero opencode
unset FAKE_OPENCODE_EXIT_CODE FAKE_GH_NO_MATCH

[ "$rc" -eq 1 ] || fail "opencode exit-nonzero: expected exit 1, got $rc"
grep -q '"outcome":"agent-failed"' "$COMPLETE_LOG" ||
  fail "opencode exit-nonzero: complete call did not report agent-failed ($(cat "$COMPLETE_LOG"))"
[ "$(cat "$OPENCODE_RUN_COUNT_FILE")" -eq 1 ] ||
  fail "opencode exit-nonzero: provider retried a non-zero deterministic failure"

echo "scenario opencode-exit-nonzero: OK"

# Regression pin: a brief with no `resume` field must leave OpenCode's
# dispatch byte-identical to today -- no `runner resume` invocation, and
# opencode gets no --session flag.
export FAKE_BRIEF_NO_RESUME=1
run_scenario opencode-no-resume opencode
unset FAKE_BRIEF_NO_RESUME

[ "$rc" -eq 0 ] || fail "opencode no-resume: expected exit 0, got $rc"
if grep -q -- 'runner resume' "$NODE_ARGS_LOG" 2>/dev/null; then
  fail "opencode no-resume: runner resume was invoked despite no resume field in the brief ($(cat "$NODE_ARGS_LOG"))"
fi
grep -q -- 'run --model homelab/default --auto' "$OPENCODE_ARGS_LOG" ||
  fail "opencode no-resume: opencode was not invoked with a fresh run ($(cat "$OPENCODE_ARGS_LOG"))"
if grep -q -- '--session' "$OPENCODE_ARGS_LOG"; then
  fail "opencode no-resume: opencode received --session despite no resume field in the brief ($(cat "$OPENCODE_ARGS_LOG"))"
fi

echo "scenario opencode-no-resume: OK"

# A requested OpenCode restore that fails is fatal -- same fail-closed
# contract as Claude's and Codex's own resume-failed scenarios.
export FAKE_RESUME_FAIL=1
run_scenario opencode-resume-failed opencode
unset FAKE_RESUME_FAIL

[ "$rc" -ne 0 ] || fail "opencode resume-failed: expected a restore failure"
[ -f "$COMPLETE_LOG" ] || fail "opencode resume-failed: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"runner-failed"' "$COMPLETE_LOG" ||
  fail "opencode resume-failed: complete call did not report runner-failed ($(cat "$COMPLETE_LOG"))"
if grep -q -- 'run --model' "$OPENCODE_ARGS_LOG"; then
  fail "opencode resume-failed: provider run started after a failed restore ($(cat "$OPENCODE_ARGS_LOG"))"
fi

echo "scenario opencode-resume-failed: OK"

# Native Work outcomes have no GitHub issue thread.  The direct runner must
# export the exact attempt and the common private outcome-file path to every
# provider so a provider can emit a marker-bound PARK instead of failing the
# ordinary PR-only deliverable lookup.  Codex is used here solely as a
# second provider; the environment and completion behavior are shared.
export FAKE_GH_NO_MATCH=1
export FAKE_NATIVE_OUTCOME=park
run_scenario codex-native-park codex
unset FAKE_GH_NO_MATCH FAKE_NATIVE_OUTCOME

[ "$rc" -eq 0 ] || fail "codex native park: expected exit 0, got $rc"
grep -Fq 'NATIVE_WORK_OUTCOME_FILE' "$CODEX_ARGS_LOG" ||
  fail "codex native park: prompt did not tell the agent about the native outcome file ($(cat "$CODEX_ARGS_LOG"))"
jq -e '.outcome == "park" and .outcomeReference == null' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "codex native park: marker-bound native outcome was not completed ($(cat "$COMPLETE_LOG"))"
native_outcome_file="$scenario_runner_temp/native-work-terminal-outcome.txt"
printf '<!-- agent-result:v1:park:g1:work:01DIRECTRUNNERTESTFIXTURE1/r1 -->\n<!-- attempt-claim:g1:work:01DIRECTRUNNERTESTFIXTURE1/r1 -->\n' | cmp -s - "$native_outcome_file" ||
  fail "codex native park: provider did not receive the shared native outcome contract ($(cat "$native_outcome_file" 2>/dev/null))"

echo "scenario codex-native-park: OK"

# The QueueExecutor adapter must enforce the two-hour OpenCode bound
# locally. A short override makes this regression deterministic without
# waiting two hours: timeout sends TERM to the trusted CLI, then the runner
# finalizes and reports the failed/no-deliverable run instead of wedging a
# queue slot indefinitely.
export FAKE_OPENCODE_SLEEP_SECONDS=2
export OPENCODE_TIMEOUT_SECONDS=1 FAKE_GH_NO_MATCH=1
run_scenario opencode-timeout opencode
unset FAKE_OPENCODE_SLEEP_SECONDS OPENCODE_TIMEOUT_SECONDS FAKE_GH_NO_MATCH

[ "$rc" -ne 0 ] || fail "opencode timeout: expected a non-zero exit, got 0"
[ -f "$COMPLETE_LOG" ] || fail "opencode timeout: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"agent-timeout"' "$COMPLETE_LOG" ||
  fail "opencode timeout: complete call did not report agent-timeout ($(cat "$COMPLETE_LOG"))"

echo "scenario opencode-timeout: OK"

[ ! -e "$tmp/opencode-startup-race" ] || fail "telemetry opened OpenCode before database initialization"

export FAKE_OPENCODE_INIT_EXIT=1
run_scenario opencode-init-failure opencode
unset FAKE_OPENCODE_INIT_EXIT
[ "$rc" -ne 0 ] || fail "OpenCode initialization failure was ignored"
[ ! -s "$OPENCODE_ARGS_LOG" ] || fail "agent ran after database initialization failure"
if grep -q 'runner sidecar' "$NODE_ARGS_LOG" 2>/dev/null; then
  fail "telemetry started after database initialization failure"
fi
grep -q '"outcome":"runner-failed"' "$COMPLETE_LOG" || fail "initialization failure misclassified"

# The queued direct path must reject a reviewed OpenCode CLI that no longer
# supports the non-interactive --auto contract before it attempts a real turn.
export FAKE_OPENCODE_NO_AUTO=1
run_scenario opencode-no-auto opencode
unset FAKE_OPENCODE_NO_AUTO

[ "$rc" -ne 0 ] || fail "opencode no-auto: expected a non-zero exit"
[ ! -s "$OPENCODE_ARGS_LOG" ] ||
  fail "opencode no-auto: invoked OpenCode after the capability preflight ($(cat "$OPENCODE_ARGS_LOG"))"
grep -q '"outcome":"runner-failed"' "$COMPLETE_LOG" ||
  fail "opencode no-auto: completion did not report runner-failed ($(cat "$COMPLETE_LOG"))"

echo "scenario opencode-no-auto: OK"

# A GitHub reply keeps its anchor, mode, reply/runbook/context, and exact
# marker lookup when it travels through the same direct runner. The marker is
# deliberately a comment rather than a PR here, proving the native verifier
# receives NUM and MODE rather than the native-work defaults.
export FAKE_ANCHOR=github
export FAKE_MODE=reply
export FAKE_REPLY='/opencode report the current status'
export FAKE_RUNBOOK='status-runbook'
export FAKE_CONTEXT='from a GitHub comment'
export FAKE_GH_NO_MATCH=1
export FAKE_GH_MARKER_COMMENT=1
run_scenario github-reply opencode
unset FAKE_ANCHOR FAKE_MODE FAKE_REPLY FAKE_RUNBOOK FAKE_CONTEXT FAKE_GH_NO_MATCH FAKE_GH_MARKER_COMMENT

[ "$rc" -eq 0 ] || fail "github reply: expected exit 0, got $rc"
context_path="$scenario_runner_temp/agent-dispatch/context.json"
jq -e '.anchor.type == "issue" and .anchor.number == 42 and .mode == "reply" and .reply == "/opencode report the current status" and .runbook == "status-runbook" and .context == "from a GitHub comment"' \
  "$context_path" >/dev/null ||
  fail "github reply: prepare context lost the anchor or dispatch parameters ($(cat "$context_path"))"
jq -e '.outcome == "comment" and .outcomeReference == null' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "github reply: marker-bound comment was misclassified ($(cat "$COMPLETE_LOG"))"

echo "scenario github-reply: OK"

# Structured reply terminal outcomes retain their dedicated semantics rather
# than being flattened to a generic comment. Both are valid successful
# executions, so the runner must also preserve its zero exit status.
export FAKE_ANCHOR=github
export FAKE_MODE=reply
export FAKE_GH_NO_MATCH=1
export FAKE_GH_MARKER_COMMENT=1
export FAKE_GH_MARKER_NO_OP=1
run_scenario github-reply-no-op opencode
unset FAKE_ANCHOR FAKE_MODE FAKE_GH_NO_MATCH FAKE_GH_MARKER_COMMENT FAKE_GH_MARKER_NO_OP

[ "$rc" -eq 0 ] || fail "github reply no-op: expected exit 0, got $rc"
jq -e '.outcome == "no-op" and .outcomeReference == null' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "github reply no-op: marker-bound no-op was misclassified ($(cat "$COMPLETE_LOG"))"

echo "scenario github-reply-no-op: OK"

export FAKE_ANCHOR=github
export FAKE_MODE=reply
export FAKE_GH_NO_MATCH=1
export FAKE_GH_MARKER_COMMENT=1
export FAKE_GH_MARKER_PARK=1
run_scenario github-reply-park opencode
unset FAKE_ANCHOR FAKE_MODE FAKE_GH_NO_MATCH FAKE_GH_MARKER_COMMENT FAKE_GH_MARKER_PARK

[ "$rc" -eq 0 ] || fail "github reply park: expected exit 0, got $rc"
jq -e '.outcome == "park" and .outcomeReference == null' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "github reply park: marker-bound park was misclassified ($(cat "$COMPLETE_LOG"))"

echo "scenario github-reply-park: OK"

# A structured park overrides a same-attempt PR, but preserves that PR as
# the reference for the control plane's human-facing blocker record.
export FAKE_ANCHOR=github
export FAKE_MODE=implement
export FAKE_GH_MARKER_COMMENT=1
export FAKE_GH_MARKER_PARK=1
run_scenario github-pr-park opencode
unset FAKE_ANCHOR FAKE_MODE FAKE_GH_MARKER_COMMENT FAKE_GH_MARKER_PARK

[ "$rc" -eq 0 ] || fail "github PR park: expected exit 0, got $rc"
jq -e '.outcome == "park" and .outcomeReference == {kind: "pull-request", number: 12}' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "github PR park: park did not override the PR while retaining its reference ($(cat "$COMPLETE_LOG"))"

echo "scenario github-pr-park: OK"

# Review mode must preserve the pull-request anchor and query its review
# evidence after the shared PR/comment lookup finds nothing.
export FAKE_ANCHOR=github
export FAKE_MODE=review
export FAKE_GITHUB_PR=1
export FAKE_GH_NO_MATCH=1
export FAKE_GH_MARKER_REVIEW=1
run_scenario github-review opencode
unset FAKE_ANCHOR FAKE_MODE FAKE_GITHUB_PR FAKE_GH_NO_MATCH FAKE_GH_MARKER_REVIEW

[ "$rc" -eq 0 ] || fail "github review: expected exit 0, got $rc"
context_path="$scenario_runner_temp/agent-dispatch/context.json"
jq -e '.anchor.type == "pull-request" and .anchor.number == 42 and .mode == "review"' \
  "$context_path" >/dev/null ||
  fail "github review: prepare context lost the PR anchor or review mode ($(cat "$context_path"))"
jq -e '.outcome == "review" and .outcomeReference == null' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "github review: marker-bound review was misclassified ($(cat "$COMPLETE_LOG"))"

echo "scenario github-review: OK"

# --- Scenario 1b: GitHub-Actions temp environment absent -------------------
# A direct-mode container is started by Docker rather than GitHub Actions, so
# it has no inherited RUNNER_TEMP. Its own fallback must be exported before
# prepare-dispatch runs; otherwise it fails after clone with
# "RUNNER_TEMP is required" and leaves the claimed work item to time out.
export FAKE_MISSING_RUNNER_TEMP=1
run_scenario missing-runner-temp
unset FAKE_MISSING_RUNNER_TEMP

[ "$rc" -eq 0 ] || fail "missing-runner-temp: expected exit 0, got $rc"
[ -f "$scenario_runner_temp/agent-dispatch/context.json" ] ||
  fail "missing-runner-temp: prepare-dispatch did not create its context"
[ -f "$COMPLETE_LOG" ] ||
  fail "missing-runner-temp: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"pull-request"' "$COMPLETE_LOG" ||
  fail "missing-runner-temp: complete call did not report outcome: pull-request ($(cat "$COMPLETE_LOG"))"

echo "scenario missing-runner-temp: OK"

# --- Scenario 1c: console endpoint is mandatory -----------------------------
# Runner images carry no production console default. The launcher provides the
# endpoint explicitly, and an incomplete launch must fail before any API call.
export FAKE_MISSING_CONSOLE_URL=1
run_scenario missing-console-url
unset FAKE_MISSING_CONSOLE_URL

[ "$rc" -ne 0 ] || fail "missing-console-url: expected missing URL failure"
[ ! -f "$COMPLETE_LOG" ] ||
  fail "missing-console-url: runner contacted the API without a console URL"

echo "scenario missing-console-url: OK"

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

# --- Scenario 1d: requested resume must fail closed --------------------------
# A restore error must settle this attempt as no-deliverable instead of
# silently replacing it with a fresh Claude dispatch.
export FAKE_RESUME_FAIL=1
run_scenario resume-failed
unset FAKE_RESUME_FAIL

[ "$rc" -ne 0 ] || fail "resume-failed: expected a restore failure"
[ -f "$COMPLETE_LOG" ] || fail "resume-failed: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"runner-failed"' "$COMPLETE_LOG" ||
  fail "resume-failed: complete call did not report runner-failed ($(cat "$COMPLETE_LOG"))"
[ ! -f "$CLAUDE_ARGS_LOG" ] ||
  fail "resume-failed: claude started after a failed restore ($(cat "$CLAUDE_ARGS_LOG"))"

echo "scenario resume-failed: OK"

# A sidecar bug that exits successfully but produces no local transcript path
# is also not permission to start a fresh session.
export FAKE_RESUME_EMPTY=1
run_scenario resume-empty
unset FAKE_RESUME_EMPTY

[ "$rc" -ne 0 ] || fail "resume-empty: expected an empty restore failure"
[ -f "$COMPLETE_LOG" ] || fail "resume-empty: direct-runner.sh never called POST .../complete"
grep -q '"outcome":"runner-failed"' "$COMPLETE_LOG" ||
  fail "resume-empty: complete call did not report runner-failed ($(cat "$COMPLETE_LOG"))"
[ ! -f "$CLAUDE_ARGS_LOG" ] ||
  fail "resume-empty: claude started after an empty restore ($(cat "$CLAUDE_ARGS_LOG"))"

echo "scenario resume-empty: OK"

# --- Scenario 1e: a resumed reply round gets the human's turn as its prompt,
# and the agent's final message is captured onto the completion payload ----
# A native reply round (mode:reply, a non-empty reply, and a resume request
# the brief carries) must get the reply prompt, not the generic "work the
# routed anchor" one -- and whatever claude prints to stdout must reach
# /complete as `message`.
export FAKE_MODE=reply
export FAKE_REPLY='Use Firestore.'
export FAKE_REPLY_CHANNEL='console'
export FAKE_REPLY_PRINCIPAL='user:jlapenna'
export FAKE_CLAUDE_STDOUT="Which database should I use?
PARK waiting on the maintainer"
run_scenario reply-prompt
unset FAKE_MODE FAKE_REPLY FAKE_REPLY_CHANNEL FAKE_REPLY_PRINCIPAL FAKE_CLAUDE_STDOUT

[ "$rc" -eq 0 ] || fail "reply-prompt: expected exit 0, got $rc"
grep -q -- '--resume sess_1' "$CLAUDE_ARGS_LOG" 2>/dev/null ||
  fail "reply-prompt: claude was not passed --resume sess_1 ($(cat "$CLAUDE_ARGS_LOG" 2>/dev/null))"
grep -q 'A human replied on console (user:jlapenna):' "$CLAUDE_ARGS_LOG" 2>/dev/null ||
  fail "reply-prompt: prompt did not carry the reply-round framing ($(cat "$CLAUDE_ARGS_LOG" 2>/dev/null))"
grep -q 'Use Firestore.' "$CLAUDE_ARGS_LOG" 2>/dev/null ||
  fail "reply-prompt: prompt did not carry the human's reply text ($(cat "$CLAUDE_ARGS_LOG" 2>/dev/null))"
jq -e '.message | contains("Which database should I use?")' < <(tail -n1 "$COMPLETE_LOG") >/dev/null ||
  fail "reply-prompt: complete payload did not capture the agent's final message ($(cat "$COMPLETE_LOG"))"

echo "scenario reply-prompt: OK"

# --- Scenario 2: no-deliverable ---------------------------------------------
# The PR-marker lookup gh api call finds nothing, so the native verifier's
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

# A current QueueExecutor brief always carries the selected Run pipeline.
# A Work spec alone is not an execution fallback: accepting it would revive
# the retired pre-cutover brief shape.
export FAKE_BRIEF_NO_PIPELINE=1
run_scenario missing-run-pipeline
unset FAKE_BRIEF_NO_PIPELINE

[ "$rc" -ne 0 ] || fail "missing-run-pipeline: expected a non-zero exit, got $rc"
[ ! -f "$CLAUDE_ARGS_LOG" ] || fail "missing-run-pipeline: claude ran from Work.spec.pipeline fallback"
[ -f "$COMPLETE_LOG" ] || fail "missing-run-pipeline: claimed run did not report its malformed brief"
grep -q 'FATAL: direct runner does not support pipeline' "$scenario_log" ||
  fail "missing-run-pipeline: did not fail explicitly ($(cat "$scenario_log"))"

echo "scenario missing-run-pipeline: OK"

# A claimed run must carry one of the three modes the direct runner knows.
# Unknown persisted values are corruption, not an implement-mode default.
export FAKE_MODE=legacy
run_scenario invalid-run-mode
unset FAKE_MODE

[ "$rc" -ne 0 ] || fail "invalid-run-mode: expected a non-zero exit, got $rc"
[ ! -f "$CLAUDE_ARGS_LOG" ] || fail "invalid-run-mode: claude ran with an unsupported mode"
[ -f "$COMPLETE_LOG" ] || fail "invalid-run-mode: claimed run did not report its malformed brief"
grep -q "FATAL: direct runner received unsupported mode 'legacy'" "$scenario_log" ||
  fail "invalid-run-mode: did not fail explicitly ($(cat "$scenario_log"))"

echo "scenario invalid-run-mode: OK"

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
grep -q '"outcome":"runner-failed"' "$COMPLETE_LOG" ||
  fail "missing-claude-token: complete call did not report outcome: runner-failed ($(cat "$COMPLETE_LOG"))"

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
grep -q '"outcome":"runner-failed"' "$COMPLETE_LOG" ||
  fail "checkout-token-401: complete call did not report outcome: runner-failed ($(cat "$COMPLETE_LOG"))"

echo "scenario checkout-token-401: OK"

# Credential contention is capacity: wait with a live heartbeat, then start
# exactly once after release. The credential payload must never reach logs.
export FAKE_BRIEF_NO_RESUME=1 FAKE_CODEX_AUTH_BUSY_COUNT=1 CODEX_AUTH_WAIT_SECONDS=10
run_scenario codex-auth-busy-then-success codex
[ "$rc" = 0 ] || fail "codex-auth-busy-then-success: exit $rc ($(cat "$scenario_log"))"
[ "$(cat "$CODEX_AUTH_REQUEST_LOG")" = 2 ] || fail 'busy credential was not retried once'
[ -s "$CODEX_ARGS_LOG" ] || fail 'Codex never started after credential release'
[ -s "$HEARTBEAT_LOG" ] || fail 'run heartbeat stopped while waiting for credentials'
! grep -q 'private-body-must-not-be-logged' "$scenario_log" || fail 'broker error body leaked'
echo 'scenario codex-auth-busy-then-success: OK'

export FAKE_CODEX_AUTH_BUSY_COUNT=100 CODEX_AUTH_WAIT_SECONDS=1
run_scenario codex-auth-wait-exhausted codex
[ "$rc" = 75 ] || fail "codex-auth-wait-exhausted: exit $rc"
[ ! -f "$CODEX_ARGS_LOG" ] || fail 'Codex started without the credential'
grep -q 'credential wait exhausted' "$COMPLETE_LOG" || fail 'completion omitted capacity diagnostic'
[ ! -s "$CODEX_AUTH_PERSIST_LOG" ] || fail 'unowned credential was persisted/released'
[ -z "$(find "$LCARS_CODEX_VOLATILE_DIR" -mindepth 1 -print -quit)" ] || fail 'volatile credential state remained'
echo 'scenario codex-auth-wait-exhausted: OK'
unset FAKE_CODEX_AUTH_BUSY_COUNT

for status in 401 403 500; do
  export FAKE_CODEX_AUTH_STATUS="$status"
  run_scenario "codex-auth-refused-$status" codex
  [ "$rc" != 0 ] || fail 'nonretryable credential error succeeded'
  [ "$(cat "$CODEX_AUTH_REQUEST_LOG")" = 1 ] || fail 'nonretryable credential error retried'
  [ ! -f "$CODEX_ARGS_LOG" ] || fail 'Codex started on a refused credential'
  grep -q "HTTP $status" "$COMPLETE_LOG" || fail 'safe HTTP diagnostic missing'
  ! grep -q 'private-body-must-not-be-logged' "$scenario_log" || fail 'broker error body leaked'
  echo "scenario codex-auth-refused-$status: OK"
done
unset FAKE_CODEX_AUTH_STATUS

export FAKE_CODEX_AUTH_TRANSPORT_FAIL=1
run_scenario codex-auth-transport-failure codex
[ "$rc" != 0 ] || fail 'transport failure succeeded'
[ "$(cat "$CODEX_AUTH_REQUEST_LOG")" = 1 ] || fail 'transport error retried indiscriminately'
grep -q 'failed in transport' "$COMPLETE_LOG" || fail 'transport failure diagnostic missing'
unset FAKE_CODEX_AUTH_TRANSPORT_FAIL
echo 'scenario codex-auth-transport-failure: OK'

export FAKE_CODEX_AUTH_BUSY_COUNT=100 CODEX_AUTH_WAIT_SECONDS=30 FAKE_CANCEL_CODEX_WAIT=1
run_scenario codex-auth-cancelled codex
[ "$rc" != 0 ] || fail 'cancelled credential wait succeeded'
grep -q 'lease busy' "$scenario_log" || fail 'cancellation did not exercise credential waiting'
grep -q 'credential wait cancelled' "$COMPLETE_LOG" || fail 'cancellation not reported'
[ ! -f "$CODEX_ARGS_LOG" ] || fail 'Codex started after cancellation'
[ -z "$(find "$LCARS_CODEX_VOLATILE_DIR" -mindepth 1 -print -quit)" ] || fail 'cancelled wait left volatile state'
echo 'scenario codex-auth-cancelled: OK'
unset FAKE_PIPELINE FAKE_BRIEF_NO_RESUME FAKE_CODEX_AUTH_BUSY_COUNT CODEX_AUTH_WAIT_SECONDS FAKE_CANCEL_CODEX_WAIT


# Published, exact-marker deliverables survive a provider's nonzero exit.
export FAKE_OPENCODE_EXIT_CODE=124
run_scenario opencode-timeout-with-pr opencode
unset FAKE_OPENCODE_EXIT_CODE
[ "$rc" -eq 0 ] || fail "timeout with PR: lost a published deliverable"
jq -e '.outcome == "pull-request" and .outcomeReference.number == 12' < <(tail -n1 "$COMPLETE_LOG") >/dev/null || fail "timeout with PR: wrong outcome"

export FAKE_GH_NO_MATCH=1
export FAKE_CLAUDE_STDOUT="You've hit your weekly limit · resets Sep 13, 12am (UTC)"
run_scenario provider-quota
unset FAKE_GH_NO_MATCH FAKE_CLAUDE_STDOUT
[ "$rc" -ne 0 ] || fail "quota: expected failure"
jq -e '.outcome == "provider-limit"' < <(tail -n1 "$COMPLETE_LOG") >/dev/null || fail "quota: wrong failure classification"

# All default provider invocations receive the same two-hour allowance.
for provider in claude codex opencode; do
  run_scenario "two-hour-$provider" "$provider"
  [ "$rc" -eq 0 ] || fail "$provider default runtime: run failed"
  grep -q -- '--signal=TERM --kill-after=30s 7200s' "$scenario_runner_temp/timeout-args.log" || fail "$provider default runtime is not two hours"
done

export FAKE_GH_LOOKUP_FAIL=1
run_scenario lookup-failure
unset FAKE_GH_LOOKUP_FAIL
[ "$rc" -ne 0 ] || fail "failed lookup succeeded"
jq -e '.outcome == "verification-failed"' < <(tail -n1 "$COMPLETE_LOG") >/dev/null || fail "failed lookup lost its diagnosis"

echo "direct-runner.sh: OK"
