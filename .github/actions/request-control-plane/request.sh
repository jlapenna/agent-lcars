#!/usr/bin/env bash
# Mint a GitHub Actions OIDC token for AUDIENCE and POST the caller's
# payload(s) to ENDPOINT with it as the bearer. Input contract and the
# payload/payloads exclusivity rule live in action.yml.
set -euo pipefail

: "${ENDPOINT:?}"
: "${AUDIENCE:?}"
PAYLOAD="${PAYLOAD:-}"
PAYLOADS="${PAYLOADS:-}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-60}"
REQUEST_RESPONSE=""

if [ -n "$PAYLOAD" ] && [ -n "$PAYLOADS" ]; then
  echo "::error title=request-control-plane::Provide payload or payloads, not both."
  exit 1
fi

# Without `permissions: id-token: write` on the calling job the runner does
# not expose the OIDC request environment at all - fail with the fix named
# instead of a bare unbound-variable error.
if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] ||
  [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  echo "::error title=request-control-plane::No OIDC token environment; grant the calling job 'permissions: id-token: write'."
  exit 1
fi

token_response="$(curl --fail-with-body --silent --show-error \
  -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$AUDIENCE")"
oidc_token="$(jq -er '.value | select(type == "string" and length > 0)' \
  <<<"$token_response")"

# No argument: bodyless POST. One argument: that JSON document as the body.
post() {
  local args=(--fail-with-body --silent --show-error \
    --max-time "$TIMEOUT_SECONDS" -X POST \
    -H "Authorization: Bearer $oidc_token")
  if [ "$#" -eq 1 ]; then
    args+=(-H "Content-Type: application/json" -d "$1")
  fi
  local response
  if ! response="$(curl "${args[@]}" "$ENDPOINT" 2>&1)"; then
    printf '%s\n' "$response" >&2
    echo "::error title=request-control-plane::POST $ENDPOINT failed (response body above)."
    return 1
  fi
  REQUEST_RESPONSE="$response"
  printf '%s\n' "$response"
}

write_response() {
  # GitHub Actions' output file uses a delimiter block for arbitrary response
  # JSON. Grow the delimiter until it cannot collide with a response line,
  # so a multiline response cannot terminate its own output block.
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  local delimiter='request-control-plane-response'
  while grep -Fqx "$delimiter" <<<"$REQUEST_RESPONSE"; do
    delimiter="${delimiter}_"
  done
  {
    printf 'response<<%s\n' "$delimiter"
    printf '%s\n' "$REQUEST_RESPONSE"
    printf '%s\n' "$delimiter"
  } >> "$GITHUB_OUTPUT"
}

if [ -n "$PAYLOADS" ]; then
  failed=0
  total=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    total=$((total + 1))
    post "$line" || failed=$((failed + 1))
  done <<<"$PAYLOADS"
  if [ "$failed" -gt 0 ]; then
    echo "::error title=request-control-plane::$failed of $total POSTs to $ENDPOINT failed."
    exit 1
  fi
  echo "POST $ENDPOINT succeeded for all $total payloads."
elif [ -n "$PAYLOAD" ]; then
  post "$PAYLOAD"
  write_response
  echo "POST $ENDPOINT succeeded."
else
  post
  write_response
  echo "POST $ENDPOINT succeeded."
fi
