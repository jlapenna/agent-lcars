#!/usr/bin/env bash
# Each case below runs in its own `( ... )` subshell so exported overrides
# never leak into the next case; shellcheck can't see across that
# isolation, hence the blanket disable below.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$script_dir/download-github-attachment.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Fake `gh` on PATH: answers `gh auth token` and `gh api <path>` from
# fixtures under $FAKE_DIR, matching the real script's two call shapes.
# Missing fixtures default to "nothing found" (empty comments array, an
# issue body_html with no signed URL) so each case only sets up what it
# cares about.
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "auth" ] && [ "${2:-}" = "token" ]; then
  if [ -f "$FAKE_DIR/auth-token.fail" ]; then
    echo "fake gh: simulated auth failure" >&2
    exit 1
  fi
  if [ -f "$FAKE_DIR/auth-token" ]; then
    cat "$FAKE_DIR/auth-token"
  fi
  exit 0
fi
if [ "$1" != "api" ]; then
  echo "fake gh: unsupported invocation: $*" >&2
  exit 64
fi
path="$2"
shift 2
case "$path" in
  *"/comments?"*) key=comments; default='[]' ;;
  *"/issues/"*) key=issue; default='{"body_html":""}' ;;
  *)
    echo "fake gh: unrecognized api path: $path" >&2
    exit 64
    ;;
esac
if [ -f "$FAKE_DIR/$key.json" ]; then
  cat "$FAKE_DIR/$key.json"
else
  printf '%s\n' "$default"
fi
FAKE_GH
chmod +x "$fake_bin/gh"

# Fake `curl` on PATH: records the requested URL and any Authorization
# header to $FAKE_DIR/curl-last-{url,auth} for assertions, then either
# writes fixture bytes to --output (success) or exits non-zero the way
# `curl --fail` does on an HTTP error response, controlled by
# $FAKE_DIR/curl.fail.
cat > "$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
auth_header=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --output) output="$arg" ;;
    -H) case "$arg" in Authorization:*) auth_header="$arg" ;; esac ;;
  esac
  case "$arg" in
    https://*) url="$arg" ;;
  esac
  prev="$arg"
done
printf '%s' "$url" > "$FAKE_DIR/curl-last-url"
printf '%s' "$auth_header" > "$FAKE_DIR/curl-last-auth"
if [ -f "$FAKE_DIR/curl.fail" ]; then
  echo "fake curl: simulated HTTP failure" >&2
  exit 22
fi
printf 'FAKE-ATTACHMENT-BYTES' > "$output"
FAKE_CURL
chmod +x "$fake_bin/curl"

export PATH="$fake_bin:$PATH"

# Runs the script against $url, writing to a fresh per-case output path
# under $test_root/$name/out. Extra args (repo/issue-number) pass through.
# Sets $status, $stderr, and $output_path for the caller to assert on.
run_case() {
  local name="$1"
  local url="$2"
  shift 2
  local case_dir="$test_root/$name"
  mkdir -p "$case_dir"
  export FAKE_DIR="$case_dir"
  output_path="$case_dir/out"
  set +e
  bash "$script" "$url" "$output_path" "$@" >"$case_dir/stdout" 2>"$case_dir/stderr"
  status=$?
  set -e
  stderr="$(cat "$case_dir/stderr")"
}

# --- Case 1: an assets URL whose signed CDN URL is found in the rendered
# issue body_html downloads successfully. ---
(
  case_dir="$test_root/assets-found-in-issue"
  mkdir -p "$case_dir"
  cat > "$case_dir/issue.json" <<'JSON'
{"body_html":"<img src=\"https://private-user-images.githubusercontent.com/1/AAAA-11111111-2222-3333-4444-555555555555.png?jwt=x\">"}
JSON
  run_case assets-found-in-issue \
    'https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555' \
    example/consumer 42
  test "$status" = 0 || fail "expected success, got status $status: $stderr"
  test "$(cat "$output_path")" = "FAKE-ATTACHMENT-BYTES" || fail "output file missing expected bytes"
)

# --- Case 2: an assets URL with no signed CDN URL anywhere fails closed. ---
(
  run_case assets-not-found \
    'https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555' \
    example/consumer 42
  test "$status" = 69 || fail "expected exit 69, got $status: $stderr"
)

# --- Case 3: a files URL succeeds when the run's own credential (as `gh
# auth token` resolves it) can fetch it -- the direct-authenticated-fetch
# path, not the signed-URL path. ---
(
  case_dir="$test_root/files-succeeds"
  mkdir -p "$case_dir"
  printf 'a-real-user-pat' > "$case_dir/auth-token"
  run_case files-succeeds \
    'https://github.com/user-attachments/files/31532064/Castelli.2026.-.Logos.and.Usage.zip'
  test "$status" = 0 || fail "expected success, got status $status: $stderr"
  test "$(cat "$output_path")" = "FAKE-ATTACHMENT-BYTES" || fail "output file missing expected bytes"
  test "$(cat "$case_dir/curl-last-url")" = 'https://github.com/user-attachments/files/31532064/Castelli.2026.-.Logos.and.Usage.zip' \
    || fail "curl was not pointed at the files URL directly"
  test "$(cat "$case_dir/curl-last-auth")" = 'Authorization: Bearer a-real-user-pat' \
    || fail "curl did not carry the resolved credential as a Bearer header"
)

# --- Case 4: a files URL that this run's credential cannot fetch (the
# verified girosf#70 shape: a bot-class token 404s) fails with the
# identity-class diagnostic, not a bare curl error. ---
(
  case_dir="$test_root/files-rejected-by-endpoint"
  mkdir -p "$case_dir"
  printf 'a-bot-class-installation-token' > "$case_dir/auth-token"
  : > "$case_dir/curl.fail"
  run_case files-rejected-by-endpoint \
    'https://github.com/user-attachments/files/31532064/name.zip'
  test "$status" = 70 || fail "expected exit 70, got $status: $stderr"
  case "$stderr" in
    *"identity-class"*) ;;
    *) fail "expected the identity-class diagnostic, got: $stderr" ;;
  esac
  case "$stderr" in
    *"re-upload the desired file as an IMAGE attachment"*) ;;
    *) fail "expected the human-actionable next step, got: $stderr" ;;
  esac
  test ! -e "$output_path" || fail "must not leave a partial/empty output on failure"
)

# --- Case 5: a files URL with no resolvable credential at all fails
# clearly instead of attempting an unauthenticated request. ---
(
  case_dir="$test_root/files-no-credential"
  mkdir -p "$case_dir"
  : > "$case_dir/auth-token.fail"
  run_case files-no-credential \
    'https://github.com/user-attachments/files/31532064/name.zip'
  test "$status" = 70 || fail "expected exit 70, got $status: $stderr"
  case "$stderr" in
    *"no GitHub credential available"*) ;;
    *) fail "expected the no-credential diagnostic, got: $stderr" ;;
  esac
)

# --- Case 6: neither URL shape is rejected before any network call. ---
(
  run_case unrecognized-shape \
    'https://github.com/user-attachments/blobs/11111111-2222-3333-4444-555555555555'
  test "$status" = 64 || fail "expected exit 64, got $status: $stderr"
)

# --- Case 7: refuses to clobber an existing output file, for either
# shape. ---
(
  case_dir="$test_root/refuse-overwrite"
  mkdir -p "$case_dir"
  printf 'a-real-user-pat' > "$case_dir/auth-token"
  printf 'already here' > "$case_dir/out"
  export FAKE_DIR="$case_dir"
  set +e
  bash "$script" \
    'https://github.com/user-attachments/files/31532064/name.zip' \
    "$case_dir/out" >"$case_dir/stdout" 2>"$case_dir/stderr"
  status=$?
  set -e
  test "$status" = 73 || fail "expected exit 73, got $status: $(cat "$case_dir/stderr")"
)

echo "download-github-attachment.test.sh: all cases passed"
