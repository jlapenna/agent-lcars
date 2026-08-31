#!/usr/bin/env bash
# Hermetic tests for request.sh: a PATH-shimmed curl records every
# invocation and plays back canned token-mint and POST responses, so the
# real script logic (token mint, header/body assembly, bodyless POST,
# response output encoding, batch attempt-all semantics, loud failure) runs
# with no network.
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/request.sh"

# The runner evaluates expression syntax anywhere in action metadata,
# including descriptions. Repository vars are unavailable while loading a
# composite (see assert-repo-vars' 2026-08-05 incident).
if grep -Fq '${{ vars.' "$action_dir/action.yml"; then
  echo "FAIL: action metadata must not reference the vars expression context" >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

mkdir -p "$workdir/bin"
cat > "$workdir/bin/curl" <<'SHIM'
#!/usr/bin/env bash
# Shim: append every argv to CURL_LOG. The token mint is recognized by the
# OIDC request URL appearing in argv; POSTs consume one line of
# POST_RESPONSES per call ("<exit-code> <body...>").
set -euo pipefail
printf '%s\n' "$*" >> "$CURL_LOG"
for arg in "$@"; do
  if [[ "$arg" == "$FAKE_OIDC_URL"* ]]; then
    printf '{"value":"%s"}' "$FAKE_OIDC_TOKEN"
    exit 0
  fi
done
call="$(( $(cat "$POST_CALLS") + 1 ))"
echo "$call" > "$POST_CALLS"
line="$(sed -n "${call}p" "$POST_RESPONSES")"
status="${line%% *}"
if [ "${MULTILINE_RESPONSE:-}" = 'json' ]; then
  printf '{"accepted":\ntrue}'
  exit "$status"
fi
if [ "${MULTILINE_RESPONSE:-}" = 'delimiter' ]; then
  printf 'request-control-plane-response\n{"ok":true}'
  exit "$status"
fi
printf '%s\n' "${line#* }"
exit "$status"
SHIM
chmod +x "$workdir/bin/curl"

run() {
  # $1 = newline-list of "<exit> <body>" POST responses; rest = env pairs.
  printf '%s\n' "$1" > "$workdir/post-responses"
  shift
  : > "$workdir/curl.log"
  : > "$workdir/github-output"
  echo 0 > "$workdir/post-calls"
  set +e
  output="$(
    cd "$workdir" &&
      env PATH="$workdir/bin:$PATH" \
        CURL_LOG="$workdir/curl.log" \
        POST_RESPONSES="$workdir/post-responses" \
        POST_CALLS="$workdir/post-calls" \
        GITHUB_OUTPUT="$workdir/github-output" \
        FAKE_OIDC_URL='https://oidc.example/token' \
        FAKE_OIDC_TOKEN='fake-oidc-jwt' \
        ACTIONS_ID_TOKEN_REQUEST_URL='https://oidc.example/token?api-version=2' \
        ACTIONS_ID_TOKEN_REQUEST_TOKEN='runner-bearer' \
        ENDPOINT='https://lcars.example/api/work/v1/dispatches/github' \
        AUDIENCE='agent-lcars-work' \
        TIMEOUT_SECONDS='60' \
        "$@" bash "$script" 2>&1
  )"
  status=$?
  set -e
  curl_log="$(cat "$workdir/curl.log")"
  github_output="$(cat "$workdir/github-output")"
}

fail() {
  echo "FAIL: $1" >&2
  echo "--- output ---" >&2
  echo "$output" >&2
  echo "--- curl log ---" >&2
  echo "$curl_log" >&2
  exit 1
}

# 1. Single payload: token minted for the audience, then one POST carrying
#    the bearer, the JSON content type, and the exact body.
run $'0 {"ok":true}' PAYLOAD='{"issue": 7}'
test "$status" = 0 || fail "single payload must succeed"
grep -q 'audience=agent-lcars-work' <<<"$curl_log" ||
  fail "token mint must request the audience"
grep -q 'Authorization: bearer runner-bearer' <<<"$curl_log" ||
  fail "token mint must use the runner's request bearer"
grep -q 'Authorization: Bearer fake-oidc-jwt' <<<"$curl_log" ||
  fail "POST must carry the minted token"
grep -q 'Content-Type: application/json' <<<"$curl_log" ||
  fail "POST with a body must declare JSON"
grep -Fq '{"issue": 7}' <<<"$curl_log" || fail "POST must send the exact body"
grep -q -- '--max-time 60' <<<"$curl_log" || fail "POST must apply the timeout"
test "$(sed -n '2p' "$workdir/github-output")" = '{"ok":true}' ||
  fail "single payload must expose the exact response as an action output"

# 2. No payload at all: still exactly one POST, bodyless, no content type.
run $'0 {"scanned":0}'
test "$status" = 0 || fail "bodyless POST must succeed"
post_lines="$(grep -c -- '-X POST' <<<"$curl_log")"
test "$post_lines" = 1 || fail "bodyless mode must POST exactly once"
grep -q 'Content-Type' <<<"$curl_log" &&
  fail "bodyless POST must not declare a content type"
test "$(sed -n '2p' "$workdir/github-output")" = '{"scanned":0}' ||
  fail "bodyless request must expose its response as an action output"

# 3. Batch: one token mint, one POST per non-blank line, in order.
run $'0 ok1\n0 ok2\n0 ok3' PAYLOADS=$'{"issue":1}\n\n{"issue":2}\n{"issue":3}'
test "$status" = 0 || fail "batch of three must succeed"
mints="$(grep -c 'audience=' <<<"$curl_log")"
test "$mints" = 1 || fail "batch must mint exactly one token"
post_lines="$(grep -c -- '-X POST' <<<"$curl_log")"
test "$post_lines" = 3 || fail "batch must POST once per non-blank line"
grep -Fq '{"issue":3}' <<<"$curl_log" || fail "batch must send every line"
test -z "$github_output" || fail "batch requests must not publish one ambiguous response"

# 4. Batch attempt-all: a mid-batch failure still attempts the rest, then
#    fails the step naming the failure count.
run $'0 ok1\n22 upstream said no\n0 ok3' PAYLOADS=$'{"issue":1}\n{"issue":2}\n{"issue":3}'
test "$status" != 0 || fail "batch with a failed POST must fail"
post_lines="$(grep -c -- '-X POST' <<<"$curl_log")"
test "$post_lines" = 3 || fail "a mid-batch failure must not stop later POSTs"
grep -q '1 of 3 POSTs' <<<"$output" || fail "batch failure must name the count"
grep -q 'upstream said no' <<<"$output" ||
  fail "batch failure must surface the response body"

# 5. Single-payload non-2xx: loud failure with the response body.
run $'22 the control plane rejected this' PAYLOAD='{"issue": 7}'
test "$status" != 0 || fail "non-2xx must fail the step"
grep -q 'the control plane rejected this' <<<"$output" ||
  fail "failure must surface the response body"
grep -q '::error' <<<"$output" || fail "failure must emit a workflow error"

# 6. payload and payloads together: rejected before any network call.
run $'0 unused' PAYLOAD='{"a":1}' PAYLOADS='{"b":2}'
test "$status" != 0 || fail "payload+payloads must be rejected"
test -z "$curl_log" || fail "exclusivity failure must make no requests"

# 7. Missing OIDC environment: fails naming the id-token permission.
set +e
output="$(env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  ENDPOINT='https://lcars.example/x' AUDIENCE='a' bash "$script" 2>&1)"
status=$?
set -e
test "$status" != 0 || fail "missing OIDC env must fail"
grep -q "id-token: write" <<<"$output" ||
  fail "missing OIDC env must name the permission fix"

# 8. A formatted JSON response is encoded as a multiline output block, not a
# single-line assignment that GitHub Actions would truncate.
run $'0 unused' PAYLOAD='{"issue": 7}' MULTILINE_RESPONSE=json
test "$status" = 0 || fail "multiline response must succeed"
test "$(sed -n '2,3p' "$workdir/github-output")" = $'{"accepted":\ntrue}' ||
  fail "multiline response must remain intact in the action output"

# 9. The output delimiter grows when it occurs as a complete response line,
# preventing untrusted response text from closing the output block early.
run $'0 unused' PAYLOAD='{"issue": 7}' MULTILINE_RESPONSE=delimiter
test "$status" = 0 || fail "delimiter-collision response must succeed"
test "$(sed -n '1p' "$workdir/github-output")" = \
  'response<<request-control-plane-response_' ||
  fail "output delimiter must not collide with a response line"
test "$(sed -n '2,3p' "$workdir/github-output")" = \
  $'request-control-plane-response\n{"ok":true}' ||
  fail "delimiter-collision response must remain intact"

echo "ok - request-control-plane request.sh"
