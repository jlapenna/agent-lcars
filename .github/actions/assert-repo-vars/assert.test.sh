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

run_profile() {
  set +e
  output="$(GITHUB_ACTION_PATH="$action_dir" PROFILE="$1" VARS="$2" bash "$script" 2>&1)"
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
run $'MAINTAINER_LOGIN=jlapenna\nAGENT_FLEET_LOGIN=agent-lcars-bot'
test "$status" = 0 || fail "all-present must pass"

# One empty value fails, naming it.
run $'MAINTAINER_LOGIN=jlapenna\nAGENT_FLEET_LOGIN='
test "$status" = 1 || fail "an empty value must fail"
case "$output" in
  *"Missing required repo variable(s): AGENT_FLEET_LOGIN"*) ;;
  *) fail "the missing name must be reported" ;;
esac

# A declared profile adds only manifest-required variables; optional lane
# flags deliberately keep their missing-is-enabled/disarmed semantics.
run_profile agent-lcars $'AGENT_FLEET_LOGIN=agent-lcars-bot'
test "$status" = 0 || fail "profile required variable present must pass"

run_profile agent-lcars $'AGENT_FLEET_LOGIN='
test "$status" = 1 || fail "profile required variable missing must fail"
case "$output" in
  *"Missing required repo variable(s): AGENT_FLEET_LOGIN"*) ;;
  *) fail "profile failure must name manifest-required variable" ;;
esac

run_profile unknown $'AGENT_FLEET_LOGIN=agent-lcars-bot'
test "$status" = 1 || fail "unknown profile must fail"
case "$output" in
  *"Unknown variable contract profile: unknown"*) ;;
  *) fail "unknown profile must be explicit" ;;
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
