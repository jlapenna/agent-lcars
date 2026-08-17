#!/usr/bin/env bash
# Hermetic tests for check-canonical-sync's check.sh.
#
# No network: --base points at a file:// tree standing in for
# raw.githubusercontent.com, so the comparison and exit-code contract are what
# is under test rather than curl's ability to reach GitHub.

set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="$script_dir/check.sh"
failures=0

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok - $name"
  else echo "FAIL - $name"; failures=$((failures + 1)); fi
}
status_is() {
  local want="$1"; shift
  "$@" >/dev/null 2>&1
  [ "$?" -eq "$want" ]
}

root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT; cd "$root"

# stand-in for the public canonical tree: <base>/<ref>/<path>
mkdir -p remote/main/scripts consumer/local
printf 'echo shared\n' > remote/main/scripts/shared.sh
printf 'echo shared\n' > consumer/local/shared.sh
printf 'local/shared.sh scripts/shared.sh\n' > consumer/manifest.conf
cd consumer
BASE="file://$root/remote"

run() { "$checker" --manifest manifest.conf --base "$BASE" --ref main "$@"; }

check 'a matching copy passes' status_is 0 run
check 'the pass message names the ref' \
  bash -c "\"$checker\" --manifest manifest.conf --base \"$BASE\" --ref main 2>&1 | grep -q 'match agent-lcars@main'"

# --- the regression this exists to prevent -----------------------------------
printf 'echo drifted\n' > local/shared.sh
check 'a drifted copy fails with exit 1' status_is 1 run
check 'the failure names the local file' \
  bash -c "\"$checker\" --manifest manifest.conf --base \"$BASE\" --ref main 2>&1 | grep -q 'DRIFTED  local/shared.sh'"
check 'the failure prints a copy-paste fix' \
  bash -c "\"$checker\" --manifest manifest.conf --base \"$BASE\" --ref main 2>&1 | grep -q 'fix: curl'"

# --- a deleted copy is a finding, not a skip ---------------------------------
rm local/shared.sh
check 'a missing local copy fails with exit 1' status_is 1 run
check 'the missing copy is labelled MISSING' \
  bash -c "\"$checker\" --manifest manifest.conf --base \"$BASE\" --ref main 2>&1 | grep -q 'MISSING  local/shared.sh'"
printf 'echo shared\n' > local/shared.sh

# --- unreachable source must NOT masquerade as drift -------------------------
check 'an unfetchable canonical exits 3, not 1' \
  status_is 3 "$checker" --manifest manifest.conf --base "file://$root/nonexistent" --ref main
check 'the unfetchable message says it is not a finding' \
  bash -c "\"$checker\" --manifest manifest.conf --base \"file://$root/nonexistent\" --ref main 2>&1 | grep -q 'not drift'"

# --- usage errors are distinct from findings ---------------------------------
check 'a missing manifest exits 2' \
  status_is 2 "$checker" --manifest nope.conf --base "$BASE" --ref main
check 'a malformed manifest line exits 2' \
  bash -c 'printf "only-one-column\n" > bad.conf; status=0; "'"$checker"'" --manifest bad.conf --base "'"$BASE"'" --ref main >/dev/null 2>&1 || status=$?; [ "$status" -eq 2 ]'

# --- comments and blanks are ignored -----------------------------------------
printf '\n# just a comment\n' > empty.conf
check 'a manifest with no pairs passes' \
  status_is 0 "$checker" --manifest empty.conf --base "$BASE" --ref main

# --- stray-copy tripwire (--forbid-strays) -----------------------------------
check 'in-sync with no strays passes under --forbid-strays' \
  status_is 0 run --forbid-strays
mkdir -p vendored
printf 'echo shared\n' > vendored/shared.sh
check 'an undeclared copy of a canonicalized basename fails under --forbid-strays' \
  status_is 1 run --forbid-strays
check 'the stray failure is labelled STRAY with the undeclared path' \
  bash -c "\"$checker\" --manifest manifest.conf --base \"$BASE\" --ref main --forbid-strays 2>&1 | grep -q 'STRAY    vendored/shared.sh'"
check 'strays are opt-in: default mode ignores undeclared copies' \
  status_is 0 run
rm -rf vendored

if [ "$failures" -gt 0 ]; then
  echo "check.test.sh: $failures case(s) failed" >&2; exit 1
fi
echo "check.test.sh: all cases passed"
