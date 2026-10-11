#!/usr/bin/env bash
# Sourced by the trusted bootstrap. A shared run token never authorizes a
# duplicate Pod to execute a provider in receipt mode.
WORKER_GENERATION=''
WORKER_IDENTITY_FILE='/run/agent-lcars-identity/token'
worker_identity_config() {
  [ -n "${LCARS_CAPACITY_RECEIPT:-}" ] || return 0
  local identity
  identity="$(<"$WORKER_IDENTITY_FILE")" || return 1
  [[ "$identity" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || return 1
  printf 'header = "x-lcars-worker-identity: %s"\n' "$identity"
  if [ -n "$WORKER_GENERATION" ]; then
    printf 'header = "x-lcars-worker-generation: %s"\n' "$WORKER_GENERATION"
  fi
}
worker_activate() {
  [ -n "${LCARS_CAPACITY_RECEIPT:-}" ] || return 0
  local remaining="${1:-45}" response status generation body_file activation_deadline
  [[ "$remaining" =~ ^[1-9][0-9]*$ ]] || return 124
  [ "$remaining" -le 45 ] || remaining=45
  activation_deadline=$(($(monotonic_seconds) + remaining))
  [ -r "$WORKER_IDENTITY_FILE" ] || return 1
  # The validated receipt is trusted Job metadata, never a provider-selected
  # pool, arbitrary Pod identity, or an environment token logged in argv.
  if ! jq -e --arg run "$LCARS_RUN_ID" '
    type == "object" and .runId == $run and
    (.poolId|type=="string" and length>0 and length<=175) and
    (.nonce|type=="string" and length>=16 and length<=128) and
    (.slot|type=="number" and floor==. and .>=0) and
    (.revision|type=="number" and floor==. and .>0)
  ' <<<"$LCARS_CAPACITY_RECEIPT" >/dev/null; then return 1; fi
  [[ "${LCARS_CAPACITY_JOB_UID:-}" =~ ^[A-Za-z0-9_-]{1,175}$ ]] || return 1
  body_file="$(mktemp "$RUNNER_TEMP/activation.XXXXXX")" || return 1
  chmod 600 "$body_file"
  jq -n --argjson fence "$LCARS_CAPACITY_RECEIPT" --arg jobUid "$LCARS_CAPACITY_JOB_UID" '{fence:$fence,jobUid:$jobUid}' > "$body_file"
  while true; do
    remaining=$((activation_deadline - $(monotonic_seconds)))
    if [ "$remaining" -le 0 ]; then rm -f "$body_file"; return 124; fi
    if ! response="$(curl -sS --write-out '\n%{http_code}' --config - <<CURLCFG
url = "$CONSOLE_URL/api/work/v1/runs/activate"
request = "POST"
header = "$AUTH_HEADER"
$(worker_identity_config)
header = "content-type: application/json"
connect-timeout = 5
max-time = $remaining
data-binary = "@$body_file"
CURLCFG
)"; then rm -f "$body_file"; return 1; fi
    status="${response##*$'\n'}"
    if [ "$status" = 200 ]; then
      generation="$(jq -er '.generation | select(type=="number" and floor==. and .>0 and .<=9007199254740991)' <<<"${response%$'\n'*}")" || { rm -f "$body_file"; return 1; }
      if [ -n "$WORKER_GENERATION" ] && [ "$generation" != "$WORKER_GENERATION" ]; then rm -f "$body_file"; return 1; fi
      WORKER_GENERATION="$generation"
      rm -f "$body_file"
      return 0
    fi
    # Only inventory/activation contention is retried. An invalid identity or
    # ambiguous transport never turns into permission to start a provider.
    if [ "$status" != 409 ]; then rm -f "$body_file"; return 1; fi
    sleep 1
  done
}
