#!/usr/bin/env bash
# Per-run Hindsight coding-agent memory bootstrap for QueueExecutor direct runs.
#
# The runner image bakes @vectorize-io/hindsight-coding-agents hooks, MCP
# servers and the OpenCode plugin with `{"disabled": true}` in
# ~/.hindsight/coding-agent.json so build-time smoke tests and unconfigured runs
# incur zero network calls. At run start, when a Hindsight API token is mounted
# (or supplied via HINDSIGHT_API_TOKEN) and HINDSIGHT_DISABLED is not set, this
# helper writes a mode-0600 ~/.hindsight/coding-agent.json bound to the target
# repository's isolated memory bank (`agent-lcars::<repo>`).

write_disabled_hindsight_config() {
  local hindsight_dir="$HOME/.hindsight"
  local config_file="${HINDSIGHT_CONFIG:-$hindsight_dir/coding-agent.json}"
  mkdir -m 700 -p "$(dirname "$config_file")"
  (umask 077; printf '{"disabled":true}\n' >"$config_file")
}

hindsight_bootstrap() {
  if [ "${HINDSIGHT_DISABLED:-}" = "true" ] || [ "${HINDSIGHT_DISABLED:-}" = "1" ]; then
    write_disabled_hindsight_config
    return 0
  fi

  local token_file="${HINDSIGHT_TOKEN_FILE:-/run/secrets/hindsight-api-token}"
  local token=""
  if [ -n "$token_file" ] && [ -f "$token_file" ] && [ -r "$token_file" ]; then
    token="$(tr -d '\r\n' <"$token_file")"
  elif [ -n "${HINDSIGHT_API_TOKEN:-}" ]; then
    token="$(printf '%s' "$HINDSIGHT_API_TOKEN" | tr -d '\r\n')"
  fi

  if [ -z "$token" ] || [ -z "${TARGET_REPO:-}" ]; then
    write_disabled_hindsight_config
    return 0
  fi

  local repo_slug="${TARGET_REPO#*/}"
  if [ -z "$repo_slug" ]; then
    write_disabled_hindsight_config
    return 0
  fi

  local bank_id="${HINDSIGHT_BANK_ID:-agent-lcars::${repo_slug}}"
  local api_url="${HINDSIGHT_API_URL:-https://memory.lan.jlapenna.net}"
  local hindsight_dir="$HOME/.hindsight"
  local config_file="${HINDSIGHT_CONFIG:-$hindsight_dir/coding-agent.json}"
  local tmp_file="$config_file.$$"

  mkdir -m 700 -p "$(dirname "$config_file")"
  if ! (
    umask 077
    HINDSIGHT_BOOTSTRAP_TOKEN="$token" jq -n \
      --arg apiUrl "$api_url" \
      --arg bankId "$bank_id" \
      --arg repo "$TARGET_REPO" \
      --arg pipeline "${PIPELINE:-}" \
      --arg mode "${MODE:-}" \
      --arg runId "${LCARS_RUN_ID:-}" \
      --arg attemptId "${ATTEMPT_ID:-}" \
      '{
        serverMode: "self-hosted",
        apiUrl: $apiUrl,
        apiToken: env.HINDSIGHT_BOOTSTRAP_TOKEN,
        bankId: $bankId,
        autoInject: "recall",
        manageBankConfig: true,
        autoUpdate: false,
        codebaseSurvey: false,
        autoSeed: true,
        gitIngest: "message",
        retainSessions: true,
        retainTags: [
          ("repo:" + $repo),
          "lcars:dispatched",
          ("pipeline:" + $pipeline),
          ("mode:" + $mode)
        ],
        retainMetadata: {
          repository: $repo,
          lcars_run_id: $runId,
          lcars_attempt_id: $attemptId,
          lcars_pipeline: $pipeline,
          lcars_mode: $mode
        }
      }' >"$tmp_file"
  ); then
    rm -f -- "$tmp_file"
    echo "::warning::Hindsight coding-agent config generation failed; continuing with memory disabled" >&2
    write_disabled_hindsight_config
    return 0
  fi
  mv -f -- "$tmp_file" "$config_file"
  return 0
}
