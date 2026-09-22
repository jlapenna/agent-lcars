#!/usr/bin/env bash
# Sourced by direct-runner. A successful process exit is not a deliverable.
# This helper authorizes at most the caller's one same-session correction;
# provider errors, lookup failures, and terminal Work records never qualify.
worker_completion_needed() {
  local agent_exit="$1" deadline="$2" remaining probe_dir probe_exit
  [ "$agent_exit" -eq 0 ] || return 1
  remaining=$((deadline - SECONDS))
  [ "$remaining" -gt 0 ] || return 1
  if [ "$ANCHOR_TYPE" = work ] && [ -f "${NATIVE_WORK_OUTCOME_FILE:-}" ]; then
    local result
    for result in park no-op; do
      if printf '<!-- agent-result:v1:%s:%s -->\n<!-- attempt-claim:%s -->\n' \
        "$result" "$ATTEMPT_ID" "$ATTEMPT_ID" | cmp -s - "$NATIVE_WORK_OUTCOME_FILE"; then
        return 1
      fi
    done
  fi
  probe_dir="$(mktemp -d "$RUNNER_TEMP/completion-probe.XXXXXX")" || return 1
  : > "$probe_dir/runtime.env" || return 1
  [ "$remaining" -le 60 ] || remaining=60
  probe_exit=0
  AGENT="$AGENT_NAME" REPO="$TARGET_REPO" NUM="$ISSUE" MODE="$MODE" ATTEMPT_ID="$ATTEMPT_ID" RUNTIME_ENV="$probe_dir/runtime.env" \
    timeout --signal=TERM --kill-after=5s "${remaining}s" bash "$VERIFY_OUTCOME" > "$probe_dir/result.txt" 2>&1 || probe_exit=$?
  [ "$probe_exit" -eq 1 ] &&
    grep -Fxq 'NO_DELIVERABLE=1' "$probe_dir/runtime.env" && [ $((deadline - SECONDS)) -gt 0 ]
}

worker_authorize_correction() {
  # A new execution round requires the still-live lease, not merely a saved
  # session id. Missing authorization leaves normal finalization in charge.
  curl -sf --config - >/dev/null 2>&1 <<CURLCFG
url = "$RUNS_API/heartbeat"
request = "POST"
header = "$AUTH_HEADER"
$CURL_TIMEOUT_CONFIG
CURLCFG
}

# Consumed by all three provider branches in the sourcing direct runner.
# shellcheck disable=SC2034
WORKER_COMPLETION_PROMPT='Continue the same authorized task in this existing session. The completed deliverable lookup found no exact attempt-bound artifact. Finish the remaining work and publish the requested marker-stamped deliverable. Use PARK only for a genuine human decision, approval, or access blocker, never for a provider, setup, timeout, or lookup failure. Preserve useful work. This is the only correction round and uses the original remaining time budget.'
