#!/usr/bin/env bash
# Contract test for tools/check-shell-bare-return.sh (jlapenna/homelab#1074,
# jlapenna/homelab#1087).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checker="$root/tools/check-shell-bare-return.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

fail_count=0
expect() {
  local description=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "ok: $description"
  else
    echo "FAILED: $description" >&2
    fail_count=$((fail_count + 1))
  fi
}

# Fixture bodies below spell a genuinely bare `|| return` as the token
# @BARE_RETURN@ instead of the literal text: this test script is itself a
# tracked *.sh file under tools/, and a literal `|| return` at end-of-line
# here would trip the very checker under test in CI and pre-commit.
write() {
  printf '%s\n' "$2" | sed 's/@BARE_RETURN@/|| return/' >"$1"
}

run_checker() { "$checker" "$1"; }
passes() { run_checker "$1" >/dev/null 2>&1; }
fails() { ! run_checker "$1" >/dev/null 2>&1; }

# --- the exact homelab#1074 line shape must fail -----------------------------
offender="$temp_dir/offender.sh"
write "$offender" '#!/usr/bin/env bash
set -euo pipefail
validate_base_mirror_contract() {
  [[ " ${requested_images[*]} " == *" homelab-runner "* ]] @BARE_RETURN@
}'
expect 'the exact homelab#1074 line shape fails' fails "$offender"
offender_output="$("$checker" "$offender" 2>&1 || true)"
check_line_reported() { grep -q "^${offender}:4:" <<<"$offender_output"; }
expect 'the failure names the offending file and line' check_line_reported

# --- an explicit exit code is the fix, and must pass -------------------------
fixed="$temp_dir/fixed.sh"
write "$fixed" '#!/usr/bin/env bash
set -euo pipefail
f() {
  [[ -n "$1" ]] || return 0
}'
expect '`|| return 0` passes' passes "$fixed"

# --- a deliberately annotated bare return must pass --------------------------
annotated="$temp_dir/annotated.sh"
write "$annotated" '#!/usr/bin/env bash
set -euo pipefail
f() (
  flock -n 9 || return # bare-return-ok: relays flocks own exit status
)'
expect 'a line annotated with bare-return-ok passes' passes "$annotated"

# --- prose describing the pattern in a whole-line comment must not trip it ---
documented="$temp_dir/documented.sh"
write "$documented" '#!/usr/bin/env bash
set -euo pipefail
# Never write: [[ cond ]] || return
f() { return 0; }'
expect 'a whole-line comment describing the pattern passes' passes "$documented"

# --- a file with no .sh extension but a bash shebang is still scanned -------
no_ext="$temp_dir/agent-lcars-wrapper"
write "$no_ext" '#!/usr/bin/env bash
set -euo pipefail
f() {
  [[ -n "$1" ]] @BARE_RETURN@
}'
expect 'an extensionless file with a bash shebang still fails' fails "$no_ext"

if ((fail_count > 0)); then
  echo "check-shell-bare-return.sh contract test: $fail_count failure(s)" >&2
  exit 1
fi
echo "ok: check-shell-bare-return.sh rejects a bare return after || and accepts the annotated/explicit-code forms"
