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
#
# Every call reports its outcome as exactly one stderr line (#3269), never the
# token:
#   hindsight: enabled bank=<bank> api=<url>
#   hindsight: disabled reason=<explicit|no-token|no-repo|config-error>
# `explicit` is an intended disable (HINDSIGHT_DISABLED); `no-token` means no
# readable token was mounted or supplied, `no-repo` that TARGET_REPO named no
# repository, and `config-error` that the config could not be written. The
# QueueExecutor's launch metric reports whether the token was configured.

hindsight_report() {
  printf 'hindsight: %s\n' "$*" >&2
}

write_disabled_hindsight_config() {
  local hindsight_dir="$HOME/.hindsight"
  local config_file="${HINDSIGHT_CONFIG:-$hindsight_dir/coding-agent.json}"
  # Best effort: the image already ships a disabled config, and an unwritable
  # home must not abort a dispatch that runs under errexit.
  mkdir -m 700 -p "$(dirname "$config_file")" 2>/dev/null || true
  (umask 077; printf '{"disabled":true}\n' >"$config_file") 2>/dev/null || true
}

hindsight_bootstrap() {
  if [ "${HINDSIGHT_DISABLED:-}" = "true" ] || [ "${HINDSIGHT_DISABLED:-}" = "1" ]; then
    write_disabled_hindsight_config
    hindsight_report "disabled reason=explicit"
    return 0
  fi

  local token_file="${HINDSIGHT_TOKEN_FILE:-/run/hindsight/hindsight-api-token}"
  if [ ! -f "$token_file" ] && [ -z "${HINDSIGHT_TOKEN_FILE:-}" ] && [ -f /run/secrets/hindsight-api-token ]; then
    token_file="/run/secrets/hindsight-api-token"
  fi
  local token=""
  if [ -n "$token_file" ] && [ -f "$token_file" ] && [ -r "$token_file" ]; then
    token="$(tr -d '\r\n' <"$token_file")"
  elif [ -n "${HINDSIGHT_API_TOKEN:-}" ]; then
    token="$(printf '%s' "$HINDSIGHT_API_TOKEN" | tr -d '\r\n')"
  fi

  if [ -z "$token" ]; then
    write_disabled_hindsight_config
    hindsight_report "disabled reason=no-token"
    return 0
  fi

  local repo_slug="${TARGET_REPO:-}"
  repo_slug="${repo_slug#*/}"
  if [ -z "$repo_slug" ]; then
    write_disabled_hindsight_config
    hindsight_report "disabled reason=no-repo"
    return 0
  fi

  local bank_id="${HINDSIGHT_BANK_ID:-agent-lcars::${repo_slug}}"
  local api_url="${HINDSIGHT_API_URL:-https://memory.lan.jlapenna.net}"
  local hindsight_dir="$HOME/.hindsight"
  local config_file="${HINDSIGHT_CONFIG:-$hindsight_dir/coding-agent.json}"
  local tmp_file="$config_file.$$"

  if ! mkdir -m 700 -p "$(dirname "$config_file")" 2>/dev/null || ! (
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
    hindsight_report "disabled reason=config-error"
    return 0
  fi
  if ! mv -f -- "$tmp_file" "$config_file"; then
    rm -f -- "$tmp_file"
    write_disabled_hindsight_config
    hindsight_report "disabled reason=config-error"
    return 0
  fi
  hindsight_report "enabled bank=$bank_id api=$api_url"
  return 0
}
