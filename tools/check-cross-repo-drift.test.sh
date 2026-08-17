#!/usr/bin/env bash
# Hermetic tests for check-cross-repo-drift.sh.
#
# No network and no real clones: every case supplies --fetch-root pointing at
# fixture directories, so the script's comparison logic is what is under test,
# not git's.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="$script_dir/check-cross-repo-drift.sh"
failures=0

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "ok - $name"
  else
    echo "FAIL - $name"
    failures=$((failures + 1))
  fi
}

expect_pass() { "$checker" --manifest "$1" --fetch-root "$2"; }
expect_fail() {
  local out="$3"
  if "$checker" --manifest "$1" --fetch-root "$2" >"$out" 2>&1; then return 1; fi
  return 0
}

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
cd "$root"

mkdir -p canonical consumers/sprinkles/scripts consumers/homelab/scripts
printf 'echo hello\n' > canonical/shared.sh
printf 'echo hello\n' > consumers/sprinkles/scripts/shared.sh
printf 'echo hello\n' > consumers/homelab/scripts/shared.sh

cat > manifest.conf <<EOF
# comment line is ignored
canonical/shared.sh sprinkles:scripts/shared.sh homelab:scripts/shared.sh
EOF

check 'matching copies pass' expect_pass manifest.conf consumers

# --- the regression this exists to prevent -----------------------------------
printf 'echo goodbye\n' > consumers/sprinkles/scripts/shared.sh
check 'a drifted copy is rejected' expect_fail manifest.conf consumers out1.txt
check 'the failure names the drifted repo and path' \
  grep -q 'DRIFTED  sprinkles:scripts/shared.sh' out1.txt
check 'the failure names the canonical file' \
  grep -q 'canonical/shared.sh' out1.txt
check 'the untouched copy is not reported' \
  bash -c '! grep -q "DRIFTED  homelab" out1.txt'

# --- a deleted copy is drift, not a skip -------------------------------------
printf 'echo hello\n' > consumers/sprinkles/scripts/shared.sh
rm consumers/homelab/scripts/shared.sh
check 'a missing copy is rejected rather than skipped' \
  expect_fail manifest.conf consumers out2.txt
check 'the missing-copy failure is labelled MISSING' \
  grep -q 'MISSING  homelab:scripts/shared.sh' out2.txt

# --- a missing canonical file must fail loudly -------------------------------
printf 'echo hello\n' > consumers/homelab/scripts/shared.sh
mv canonical/shared.sh canonical/moved.sh
check 'a missing canonical file is rejected' \
  expect_fail manifest.conf consumers out3.txt
check 'the missing canonical is named' \
  grep -q 'MISSING canonical canonical/shared.sh' out3.txt
mv canonical/moved.sh canonical/shared.sh

# --- comments and blank lines are not treated as entries ---------------------
printf '\n# only comments\n\n' > empty.conf
check 'a manifest with no entries passes' expect_pass empty.conf consumers

# --- a bad manifest path is an error, not a silent pass ----------------------
check 'a missing manifest is an error' \
  bash -c '"'"$checker"'" --manifest /nonexistent.conf --fetch-root consumers; [ $? -eq 2 ]'

if [ "$failures" -gt 0 ]; then
  echo "check-cross-repo-drift.test.sh: $failures case(s) failed" >&2
  exit 1
fi
echo "check-cross-repo-drift.test.sh: all cases passed"
