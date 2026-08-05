#!/usr/bin/env bash
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$action_dir/assert.sh"

# The runner evaluates expression syntax anywhere in action metadata, including
# descriptions. Repository vars are unavailable while loading a composite.
if grep -Fq '${{ vars.' "$action_dir/action.yml"; then
  echo "FAIL: action metadata must not reference the vars expression context" >&2
  exit 1
fi

run() {
  set +e
  output="$(VARS="$1" bash "$script" 2>&1)"
  status=$?
  set -e
}

fail() {
  echo "FAIL: $1" >&2
  echo "--- output ---" >&2
  echo "$output" >&2
  exit 1
}

# All present passes silently.
run $'MAINTAINER_LOGIN=jlapenna\nAGENT_FLEET_LOGIN=jclaw-bot'
test "$status" = 0 || fail "all-present must pass"

# One empty value fails, naming it.
run $'MAINTAINER_LOGIN=jlapenna\nAGENT_FLEET_LOGIN='
test "$status" = 1 || fail "an empty value must fail"
case "$output" in
  *"Missing required repo variable(s): AGENT_FLEET_LOGIN"*) ;;
  *) fail "the missing name must be reported" ;;
esac

# Every empty value is named in the single error line.
run $'A=\nB=\nC=3'
test "$status" = 1 || fail "multiple empty values must fail"
case "$output" in
  *"Missing required repo variable(s): A B"*) ;;
  *) fail "every missing name must be listed together" ;;
esac

# Blank lines and continuation lines (no '=') are ignored.
run $'A=first-line\ncontinuation without equals\n\nB=2'
test "$status" = 0 || fail "blank/continuation lines must be tolerated"

echo "assert-repo-vars/assert.test.sh: all cases passed"
