#!/usr/bin/env bash
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A real (throwaway) RSA key so the script's actual JWT-signing code path
# runs for real (openssl base64/dgst -sign), the same way it will in
# production - only the network calls are stubbed. No real GitHub App is
# involved; the fake `curl` below never validates the signature.
openssl genrsa -out "$test_root/fake-key.pem" 2048 >/dev/null 2>&1

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail

# Simulate the first FAKE_CURL_FAIL_ATTEMPTS *calls to this fake curl*
# (across every invocation in one script run, mint and revoke alike -
# tests that need only the mint call to fail keep the count well under
# the revoke call's own turn) as a transient transport failure - the
# curl_retry() wrapper's target, and the same failure mode
# jlapenna/agent-lcars#956 observed for real: curl exiting non-zero
# before ever producing a response, not an HTTP-level error status.
count_file="$FAKE_CURL_DIR/curl-call-count"
count=0
[ -f "$count_file" ] && count="$(cat "$count_file")"
count=$((count + 1))
printf '%s' "$count" > "$count_file"
if [ "$count" -le "${FAKE_CURL_FAIL_ATTEMPTS:-0}" ]; then
  echo "fake curl: simulated transient transport failure (call ${count})" >&2
  exit 60
fi

out="/dev/null"
auth_header=""
method="GET"
data=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  if [ "$prev" = "-H" ] && [[ "$arg" == Authorization:* ]]; then auth_header="$arg"; fi
  if [ "$prev" = "-X" ]; then method="$arg"; fi
  if [ "$prev" = "-d" ]; then data="$arg"; fi
  prev="$arg"
done
if [ "$method" = "DELETE" ]; then
  printf '%s\n' "$auth_header" > "$FAKE_CURL_DIR/last-delete-authorization-header"
  exit 0
fi
printf '%s\n' "$auth_header" > "$FAKE_CURL_DIR/last-authorization-header"
printf '%s' "$data" > "$FAKE_CURL_DIR/last-request-body"
printf '%s' "$FAKE_CURL_BODY" > "$out"
printf '%s' "$FAKE_CURL_STATUS"
FAKE_CURL
chmod +x "$fake_bin/curl"
export PATH="$fake_bin:$PATH"

run_case() {
  local name="$1" status="$2" body="$3" requested="$4" fail_attempts="${5:-0}"
  local case_dir="$test_root/$name"
  mkdir -p "$case_dir"
  export FAKE_CURL_DIR="$case_dir"
  export FAKE_CURL_STATUS="$status"
  export FAKE_CURL_BODY="$body"
  export FAKE_CURL_FAIL_ATTEMPTS="$fail_attempts"
  export CLIENT_ID=Iv1.testclientid
  export PRIVATE_KEY
  PRIVATE_KEY="$(cat "$test_root/fake-key.pem")"
  export INSTALLATION_ID=123456
  export REQUESTED_LEVEL="$requested"
  export RUNNER_TEMP="$case_dir"
  set +e
  output="$(bash "$action_dir/verify-workflows-grant.sh" 2>&1)"
  status_code=$?
  set -e
  printf '%s\n' "$output" > "$case_dir/output"
}

# Match: a probe token minted with this call's own permissions carries
# workflows:write, exactly what was requested.
run_case granted 201 '{"token":"ghs_fake","permissions":{"workflows":"write","contents":"write"}}' write
test "$status_code" = 0
grep -q 'has granted' "$test_root/granted/output"

# A well-formed JWT was actually sent: three non-empty dot-separated
# base64url segments in the Authorization: Bearer header of the probe mint.
auth_line="$(cat "$test_root/granted/last-authorization-header")"
bearer="${auth_line#Authorization: Bearer }"
segment_count="$(awk -F. '{print NF}' <<<"$bearer")"
test "$segment_count" = 3
for segment in $(tr '.' ' ' <<<"$bearer"); do
  test -n "$segment"
done

# The probe token was revoked afterward (best-effort DELETE, using the
# probe token itself as bearer - never the App JWT).
grep -q 'Authorization: Bearer ghs_fake' "$test_root/granted/last-delete-authorization-header"

# Mismatch: installation has not approved workflows at all.
run_case narrowed 201 '{"token":"ghs_fake","permissions":{"contents":"write"}}' write
test "$status_code" = 1
grep -q 'has not granted' "$test_root/narrowed/output"
grep -q '868' "$test_root/narrowed/output"

# Mismatch: installation has a lower level than requested.
run_case lower-level 201 '{"token":"ghs_fake","permissions":{"workflows":"read"}}' write
test "$status_code" = 1
grep -q 'has not granted' "$test_root/lower-level/output"

# Transport/auth failure minting the probe itself must fail closed, not
# silently pass.
run_case http-error 401 '{"message":"Bad credentials"}' write
test "$status_code" = 1
grep -q 'Could not mint a probe token' "$test_root/http-error/output"

# Runs unconditionally now (#903 Codex review): a caller that never sets
# permission-workflows at all (REQUESTED_LEVEL blank - e.g. an external
# published-action consumer following the pre-#868 "leave everything blank"
# pattern) and whose installation genuinely has no `workflows` grant passes
# quietly - no error, no notice (the common, unremarkable case must not add
# log noise to every existing caller fleet-wide).
run_case unrequested-and-absent 201 '{"token":"ghs_fake","permissions":{"contents":"write"}}' ''
test "$status_code" = 0
test -z "$(cat "$test_root/unrequested-and-absent/output")"

# The exact gap the Codex review on #903 found: REQUESTED_LEVEL blank, but
# the installation grants `workflows` anyway (a fully-unscoped mint once its
# installation approves the permission). Must fail closed, not silently
# hand back a token with an unrequested, more-sensitive permission.
run_case unrequested-but-granted 201 '{"token":"ghs_fake","permissions":{"workflows":"write"}}' ''
test "$status_code" = 1
grep -q 'did not request permission-workflows' "$test_root/unrequested-but-granted/output"
grep -q '868' "$test_root/unrequested-but-granted/output"
grep -q '903' "$test_root/unrequested-but-granted/output"

# The exact false-positive this script's first version produced (fixed by
# probing with the same permissions instead of reading the installation's
# ceiling): an explicit allowlist that DOES set other permission-* inputs
# but leaves permission-workflows blank must still pass, and the probe's
# own request body must actually name those other permissions and omit
# workflows - not send an empty/unscoped request that would silently
# inherit the ceiling.
export PERMISSION_ISSUES=write
export PERMISSION_CONTENTS=write
export PERMISSION_PULL_REQUESTS=write
export PERMISSION_ACTIONS=write
export PERMISSION_METADATA=read
run_case narrow-allowlist-excludes-workflows 201 '{"token":"ghs_fake","permissions":{"issues":"write","contents":"write","pull_requests":"write","actions":"write","metadata":"read"}}' ''
test "$status_code" = 0
test -z "$(cat "$test_root/narrow-allowlist-excludes-workflows/output")"
sent_body="$(cat "$test_root/narrow-allowlist-excludes-workflows/last-request-body")"
jq -e '.permissions | has("workflows") | not' <<<"$sent_body" >/dev/null
jq -e '.permissions.issues == "write" and .permissions.metadata == "read"' <<<"$sent_body" >/dev/null
unset PERMISSION_ISSUES PERMISSION_CONTENTS PERMISSION_PULL_REQUESTS PERMISSION_ACTIONS PERMISSION_METADATA

# curl_retry() (agent-lcars#956): the mint call's first two attempts hit a
# transient transport failure (the fake curl's simulated non-zero exit, the
# same shape as the real "self-signed certificate" curl exit 60), and the
# third succeeds - the script must still complete normally, exactly as if
# the first two failures never happened.
run_case transient-then-recovers 201 '{"token":"ghs_fake","permissions":{"workflows":"write","contents":"write"}}' write 2
test "$status_code" = 0
grep -q 'has granted' "$test_root/transient-then-recovers/output"
# Proves the retry loop actually ran rather than the mint call happening to
# succeed on its own first try: 2 failed mint attempts + 1 successful mint
# attempt + 1 successful revoke call = 4 fake-curl invocations total.
test "$(cat "$test_root/transient-then-recovers/curl-call-count")" = 4

# curl_retry() exhausting every attempt must still fail closed with the
# same non-zero exit curl itself produced (60 here) - not hang, not retry
# forever, and not silently continue as if the mint had succeeded. This is
# the "persistent, not transient" case: preserves the original single-curl
# script's exact failure signature (dies at the transport layer, never
# reaching the HTTP-status/"Could not mint a probe token" check below it).
run_case transient-exhausts-retries 201 '{"token":"ghs_fake","permissions":{"workflows":"write"}}' write 99
test "$status_code" = 60
! grep -q 'Could not mint a probe token' "$test_root/transient-exhausts-retries/output"
# 3 warned-and-retried attempts, then a 4th, final, unwrapped attempt that
# is left to fail loudly - matching curl_retry()'s own attempt budget.
test "$(grep -c '::warning::curl attempt' "$test_root/transient-exhausts-retries/output")" = 3
test "$(cat "$test_root/transient-exhausts-retries/curl-call-count")" = 4

echo 'verify-workflows-grant.test.sh: all cases passed'
