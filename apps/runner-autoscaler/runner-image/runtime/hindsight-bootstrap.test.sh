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
    unset HINDSIGHT_DISABLED HINDSIGHT_API_TOKEN HINDSIGHT_BANK_ID HINDSIGHT_API_URL HINDSIGHT_CONFIG HINDSIGHT_RETAIN_SESSIONS WORK_FILE TARGET_REPO
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

jq -e '.retainSessions == true and .autoInject == "recall" and .autoSeed == true' \
  "$tmp/enabled/.hindsight/coding-agent.json" >/dev/null ||
  fail "enabled: expected default retainSessions=true, autoInject=recall, autoSeed=true"

expect dream-env "enabled bank=agent-lcars::example api=https://memory.lan.jlapenna.net" false \
  HINDSIGHT_TOKEN_FILE="$tmp/token" TARGET_REPO=octo/example HINDSIGHT_RETAIN_SESSIONS=false
jq -e '.retainSessions == false and .autoInject == "none" and .autoSeed == false' \
  "$tmp/dream-env/.hindsight/coding-agent.json" >/dev/null ||
  fail "dream-env: expected retainSessions=false, autoInject=none, autoSeed=false"

printf '%s\n' '{"id":"work:1","spec":{"title":"hindsight-dream · octo/example","description":"Repository job `hindsight-dream` in `octo/example`"}}' > "$tmp/dream-work.json"
expect dream-work "enabled bank=agent-lcars::example api=https://memory.lan.jlapenna.net" false \
  HINDSIGHT_TOKEN_FILE="$tmp/token" TARGET_REPO=octo/example WORK_FILE="$tmp/dream-work.json"
jq -e '.retainSessions == false and .autoInject == "none" and .autoSeed == false' \
  "$tmp/dream-work/.hindsight/coding-agent.json" >/dev/null ||
  fail "dream-work: expected retainSessions=false, autoInject=none, autoSeed=false"

# A config directory (including an unsearchable mode-000 parent) must still
# return 0 under errexit and report exactly one config-error outcome line.
mkdir -p "$tmp/readonly-cfg" "$tmp/unsearchable-cfg"
chmod 500 "$tmp/readonly-cfg"
chmod 000 "$tmp/unsearchable-cfg"
trap 'chmod 700 "$tmp/readonly-cfg" "$tmp/unsearchable-cfg" 2>/dev/null || true; rm -rf "$tmp"' EXIT
if [ "$(id -u)" != 0 ]; then
  expect_config_error() {
    local case_name="$1" cfg_target="$2"
    local home="$tmp/$case_name"
    mkdir -p "$home"
    (
      set -euo pipefail
      unset HINDSIGHT_DISABLED HINDSIGHT_API_TOKEN
      export HOME="$home" HINDSIGHT_TOKEN_FILE="$tmp/token" TARGET_REPO=octo/example
      export HINDSIGHT_CONFIG="$cfg_target"
      # shellcheck source=hindsight-bootstrap.sh
      source "$here/hindsight-bootstrap.sh"
      hindsight_bootstrap
    ) 2> "$home/stderr" || fail "$case_name: bootstrap returned nonzero under errexit"
    local lines
    lines="$(grep -c '^hindsight: ' "$home/stderr" || true)"
    [ "$lines" = 1 ] || fail "$case_name: expected one outcome line, got $lines: $(cat "$home/stderr")"
    grep -qxF "hindsight: disabled reason=config-error" "$home/stderr" ||
      fail "$case_name: expected config-error line, got: $(cat "$home/stderr")"
    ! grep -qF "$token" "$home/stderr" || fail "$case_name: token leaked to stderr"
    echo "ok: $case_name"
  }
  expect_config_error config-error-readonly "$tmp/readonly-cfg/coding-agent.json"
  expect_config_error config-error-unsearchable "$tmp/unsearchable-cfg/sub/coding-agent.json"
fi
echo "hindsight-bootstrap.test.sh: all cases passed"
