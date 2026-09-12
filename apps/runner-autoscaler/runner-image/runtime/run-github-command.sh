#!/usr/bin/env bash
# Run-scoped gh/git authentication. The application owns the App private key;
# workers can only request another short-lived token for their claimed repo.
set -euo pipefail
set +x
command_name="${0##*/}"
case "$command_name" in
  gh) executable="$LCARS_REAL_GH" ;;
  git)
    executable="$LCARS_REAL_GIT"
    # Local Git operations need neither network nor a valid run lease.
    network=0
    for argument in "$@"; do
      case "$argument" in clone|fetch|pull|push|ls-remote|submodule) network=1 ;; esac
    done
    [ "$network" -eq 1 ] || exec "$executable" "$@"
    ;;
  *) echo 'Run GitHub helper must be invoked as gh or git' >&2; exit 2 ;;
esac
encoded_run="$(jq -rn --arg run "$LCARS_RUN_ID" '$run|@uri')"
if ! response="$(curl -sf --config - <<CURLCFG
url = "$LCARS_CONSOLE_URL/api/work/v1/runs/$encoded_run/checkout-token"
header = "Authorization: Bearer $LCARS_RUN_TOKEN"
connect-timeout = 10
max-time = 60
CURLCFG
)"; then
  echo 'Run GitHub credential refresh failed; no command was executed.' >&2
  exit 1
fi
token="$(jq -er '.token | select(type == "string" and length > 0)' <<<"$response")"
export GH_TOKEN="$token" GITHUB_TOKEN="$token" ACTIONS_RERUN_TOKEN="$token"
if [ "$command_name" = git ]; then
  # Reset persisted headers before supplying this invocation's fresh token.
  # Environment-based git config keeps the bearer out of process argv.
  count="${GIT_CONFIG_COUNT:-0}"
  [[ "$count" =~ ^[0-9]+$ ]] || exit 2
  export "GIT_CONFIG_KEY_$count=http.https://github.com/.extraheader"
  export "GIT_CONFIG_VALUE_$count="
  count=$((count + 1))
  export "GIT_CONFIG_KEY_$count=http.https://github.com/.extraheader"
  export "GIT_CONFIG_VALUE_$count=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 -w0)"
  export GIT_CONFIG_COUNT=$((count + 1))
fi
exec "$executable" "$@"
