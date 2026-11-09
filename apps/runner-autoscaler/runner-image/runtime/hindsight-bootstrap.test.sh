#!/usr/bin/env bash
# Contract test for hindsight-bootstrap.sh's per-run outcome line (#3269):
# every path reports exactly one `hindsight: ...` stderr line, distinguishes
# intended from unexpected disables, and never prints the token.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

token='fake-hindsight-token-secret123456'
printf '%s\n' "$token" > "$tmp/token"

# Runs the bootstrap in a clean subshell with the given environment and
# asserts its single outcome line and resulting config state.
expect() {
  local name="$1" want_line="$2" want_disabled="$3"
  shift 3
  local home="$tmp/$name"
  mkdir -p "$home"
  (
    unset HINDSIGHT_DISABLED HINDSIGHT_API_TOKEN HINDSIGHT_BANK_ID HINDSIGHT_API_URL HINDSIGHT_CONFIG TARGET_REPO
    export HOME="$home" HINDSIGHT_TOKEN_FILE="$tmp/missing"
    export "$@"
    # shellcheck source=hindsight-bootstrap.sh
    source "$here/hindsight-bootstrap.sh"
    hindsight_bootstrap
  ) 2> "$home/stderr" || fail "$name: bootstrap returned nonzero"
  local lines
  lines="$(grep -c '^hindsight: ' "$home/stderr" || true)"
  [ "$lines" = 1 ] || fail "$name: expected one outcome line, got $lines: $(cat "$home/stderr")"
  grep -qxF "hindsight: $want_line" "$home/stderr" ||
    fail "$name: expected 'hindsight: $want_line', got: $(cat "$home/stderr")"
  ! grep -qF "$token" "$home/stderr" || fail "$name: token leaked to stderr"
  jq -e --argjson d "$want_disabled" '(.disabled // false) == $d' "$home/.hindsight/coding-agent.json" >/dev/null ||
    fail "$name: coding-agent.json disabled != $want_disabled"
  echo "ok: $name"
}

expect enabled "enabled bank=agent-lcars::example api=https://memory.lan.jlapenna.net" false \
  HINDSIGHT_TOKEN_FILE="$tmp/token" TARGET_REPO=octo/example
expect enabled-env-token "enabled bank=agent-lcars::example api=https://memory.lan.jlapenna.net" false \
  HINDSIGHT_API_TOKEN="$token" TARGET_REPO=octo/example
expect explicit "disabled reason=explicit" true \
  HINDSIGHT_DISABLED=true HINDSIGHT_TOKEN_FILE="$tmp/token" TARGET_REPO=octo/example
expect no-token "disabled reason=no-token" true TARGET_REPO=octo/example
expect no-repo "disabled reason=no-repo" true HINDSIGHT_TOKEN_FILE="$tmp/token" TARGET_REPO=
expect no-repo-slug "disabled reason=no-repo" true HINDSIGHT_TOKEN_FILE="$tmp/token" TARGET_REPO=octo/
# A config directory that cannot be written into must still report, not fail.
mkdir -p "$tmp/readonly-cfg"
chmod 500 "$tmp/readonly-cfg"
if [ "$(id -u)" != 0 ]; then
  expect_config_error() {
    local home="$tmp/config-error"
    mkdir -p "$home"
    (
      unset HINDSIGHT_DISABLED HINDSIGHT_API_TOKEN
      export HOME="$home" HINDSIGHT_TOKEN_FILE="$tmp/token" TARGET_REPO=octo/example
      export HINDSIGHT_CONFIG="$tmp/readonly-cfg/coding-agent.json"
      # shellcheck source=hindsight-bootstrap.sh
      source "$here/hindsight-bootstrap.sh"
      hindsight_bootstrap
    ) 2> "$home/stderr" || true
    grep -qxF "hindsight: disabled reason=config-error" "$home/stderr" ||
      fail "config-error: expected config-error line, got: $(cat "$home/stderr")"
    ! grep -qF "$token" "$home/stderr" || fail "config-error: token leaked to stderr"
    echo "ok: config-error"
  }
  expect_config_error
fi
echo "hindsight-bootstrap.test.sh: all cases passed"
