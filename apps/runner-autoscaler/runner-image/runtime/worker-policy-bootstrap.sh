#!/usr/bin/env bash
# Sourced once by direct-runner. The rollout selector is set by the trusted
# deployment only after that provider's native canaries qualify. It is not
# inferred from task content or from whether a hook happens to be present.
worker_policy_bootstrap() {
  local config_path="$1" selected=false provider
  local -a providers=()
  IFS=, read -r -a providers <<< "${LCARS_WORKER_POLICY_PROVIDERS:-}"
  for provider in "${providers[@]}"; do
    case "$provider" in
      claude|codex|opencode) ;;
      '') continue ;;
      *) echo 'FATAL: invalid worker-policy rollout selection' >&2; return 1 ;;
    esac
    if [ "$provider" = "$PIPELINE" ]; then selected=true; fi
  done
  $selected || return 0
  export LCARS_WORKER_CONTEXT="$RUNNER_TEMP/worker-policy-context.json"
  local setup="${WORKER_POLICY_SETUP:-/opt/agent-tools/bin/worker-hook-setup.cjs}"
  if ! "${WORKER_POLICY_NODE:-node}" "$setup" --bootstrap "$PIPELINE" "$config_path" \
    "$LCARS_WORKER_CONTEXT" "$AGENT_DISPATCH_CONTEXT" "$LCARS_RUN_ID" "$ATTEMPT_ID" \
    > "$RUNNER_TEMP/worker-policy-setup.json"; then
    EARLY_FAILURE_MESSAGE='Worker policy setup or control execution verification failed'
    echo "FATAL: $EARLY_FAILURE_MESSAGE; worker will not launch" >&2
    return 1
  fi
  if ! jq -e '.controlSmokePassed == true and .executionSmokeRequired == false' "$RUNNER_TEMP/worker-policy-setup.json" >/dev/null; then
    EARLY_FAILURE_MESSAGE='Worker policy setup did not prove control execution'
    echo "FATAL: $EARLY_FAILURE_MESSAGE; worker will not launch" >&2
    return 1
  fi
  if [ "$PIPELINE" = codex ]; then
    # Isolated worker runtime; native canaries exercise these exact flags.
    CODEX_HOOK_ARGS=(--enable hooks --dangerously-bypass-hook-trust)
  fi
}
