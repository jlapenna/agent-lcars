#!/usr/bin/env bash
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# A real (throwaway) RSA key so the script's actual JWT-signing code path
# runs for real (openssl base64/dgst -sign), the same way it will in
# production - only the network call is stubbed. No real GitHub App is
# involved; the fake `curl` below never validates the signature.
openssl genrsa -out "$test_root/fake-key.pem" 2048 >/dev/null 2>&1

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
out=""
auth_header=""
url=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
  fi
  if [ "$prev" = "-H" ] && [[ "$arg" == Authorization:* ]]; then
    auth_header="$arg"
  fi
  prev="$arg"
  url="$arg"
done
printf '%s\n' "$auth_header" > "$FAKE_CURL_DIR/last-authorization-header"
printf '%s\n' "$url" > "$FAKE_CURL_DIR/last-url"
printf '%s' "$FAKE_CURL_BODY" > "$out"
printf '%s' "$FAKE_CURL_STATUS"
FAKE_CURL
chmod +x "$fake_bin/curl"
export PATH="$fake_bin:$PATH"

run_case() {
  local name="$1" status="$2" body="$3" requested="$4"
  local case_dir="$test_root/$name"
  mkdir -p "$case_dir"
  export FAKE_CURL_DIR="$case_dir"
  export FAKE_CURL_STATUS="$status"
  export FAKE_CURL_BODY="$body"
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

# Match: the installation reports workflows:write, exactly what was requested.
run_case granted 200 '{"permissions":{"workflows":"write","contents":"write"}}' write
test "$status_code" = 0
grep -q 'has granted' "$test_root/granted/output"

# A well-formed JWT was actually sent: three non-empty dot-separated
# base64url segments in the Authorization: Bearer header.
auth_line="$(cat "$test_root/granted/last-authorization-header")"
bearer="${auth_line#Authorization: Bearer }"
segment_count="$(awk -F. '{print NF}' <<<"$bearer")"
test "$segment_count" = 3
for segment in $(tr '.' ' ' <<<"$bearer"); do
  test -n "$segment"
done

# Mismatch: installation has not approved workflows at all.
run_case narrowed 200 '{"permissions":{"contents":"write"}}' write
test "$status_code" = 1
grep -q 'has not granted' "$test_root/narrowed/output"
grep -q '868' "$test_root/narrowed/output"

# Mismatch: installation has a lower level than requested.
run_case lower-level 200 '{"permissions":{"workflows":"read"}}' write
test "$status_code" = 1
grep -q 'has not granted' "$test_root/lower-level/output"

# Transport/auth failure reading the installation itself must fail closed,
# not silently pass.
run_case http-error 401 '{"message":"Bad credentials"}' write
test "$status_code" = 1
grep -q 'Could not read installation' "$test_root/http-error/output"

# Runs unconditionally now (#903 Codex review): a caller that never sets
# permission-workflows at all (REQUESTED_LEVEL blank - e.g. an external
# published-action consumer following the pre-#868 "leave everything blank"
# pattern) and whose installation genuinely has no `workflows` grant passes
# quietly - no error, no notice (the common, unremarkable case must not add
# log noise to every existing caller fleet-wide).
run_case unrequested-and-absent 200 '{"permissions":{"contents":"write"}}' ''
test "$status_code" = 0
test -z "$(cat "$test_root/unrequested-and-absent/output")"

# The exact gap the Codex review on #903 found: REQUESTED_LEVEL blank, but
# the installation grants `workflows` anyway (a fully-unscoped mint once its
# installation approves the permission). Must fail closed, not silently
# hand back a token with an unrequested, more-sensitive permission.
run_case unrequested-but-granted 200 '{"permissions":{"workflows":"write"}}' ''
test "$status_code" = 1
grep -q 'did not request permission-workflows' "$test_root/unrequested-but-granted/output"
grep -q '868' "$test_root/unrequested-but-granted/output"
grep -q '903' "$test_root/unrequested-but-granted/output"

echo 'verify-workflows-grant.test.sh: all cases passed'
