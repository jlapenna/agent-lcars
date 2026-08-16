#!/usr/bin/env bash
# Regression tests for the run-status gate (#1283). The bug this covers was
# invisible from outside: a healthy run failed as a silent startup crash.
set -uo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-claude-run-status.sh"
root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT
fail=0
check() { # check <name> <expected-exit> <file>
  bash "$script" "$3" >/dev/null 2>&1; local got=$?
  if [ "$got" -eq "$2" ]; then echo "  ok   $1"; else echo "  FAIL $1 (expected exit $2, got $got)"; fail=1; fi
}

# The exact shape that was wrongly failed: sub-dollar cost, no error.
# `grep '"total_cost_usd": 0'` substring-matches 0.7592557.
cat > "$root/healthy-subdollar.json" <<'JSON'
[{"type": "result", "total_cost_usd": 0.7592557, "is_error": false}]
JSON
# NOTE: every fixture below uses the real execution file's formatting --
# a space after each colon. That is not cosmetic. The bug being guarded
# greps for the literal '"total_cost_usd": 0' WITH a space, so a compact
# fixture ({"total_cost_usd":0.75}) cannot reproduce it and the test would
# pass against the broken implementation it exists to catch. Verified: with
# compact fixtures the two headline cases pass against the old grep gate.
check "healthy sub-dollar run passes (the #1283 false positive)" 0 "$root/healthy-subdollar.json"

# The other half of that false positive: the agent read claude.yml, so the
# guard's own text arrived as transcript content. Structure-aware traversal
# must not see strings as result fields.
# THE case #1283 was actually about, reproduced. A failed tool call -- a
# grep with no match, a missing file, any non-zero command -- sets
# "is_error": true on its OWN tool_result message. The run's real result is
# is_error:false with a normal cost. The old gate matched the tool result's
# flag and prefix-matched the cost, and failed a healthy run.
#
# So it failed any run with one failed tool call and a cost under a dollar.
# That is most short runs. Verified: this fixture fails the old grep gate
# and passes the current one.
cat > "$root/failed-tool-call.json" <<'JSON'
[{"type": "user", "message": {"content": [{"type": "tool_result", "is_error": true, "content": "grep: no match"}]}},
 {"type": "result", "total_cost_usd": 0.7592557, "is_error": false}]
JSON
check "healthy run with a failed tool call passes (the real #1283 defect)" 0 "$root/failed-tool-call.json"

# Genuine startup crash: errored AND spent nothing. Must still fail.
cat > "$root/genuine-crash.json" <<'JSON'
[{"type": "result", "total_cost_usd": 0, "is_error": true}]
JSON
check "genuine crash (is_error + zero cost) still fails" 1 "$root/genuine-crash.json"

# Genuine auth failure.
cat > "$root/auth-401.json" <<'JSON'
[{"type": "result", "total_cost_usd": 0, "is_error": false, "api_error_status": 401}]
JSON
check "401 with zero cost still fails" 1 "$root/auth-401.json"

# Errored but spent money: a mid-run failure, not a startup crash. The
# original condition required both, and that stays.
cat > "$root/errored-but-spent.json" <<'JSON'
[{"type": "result", "total_cost_usd": 1.25, "is_error": true}]
JSON
check "errored run that spent money is not a startup crash" 0 "$root/errored-but-spent.json"

check "unreadable execution file fails" 1 "$root/does-not-exist.json"

cat > "$root/no-result.json" <<'JSON'
[{"type": "assistant", "text": "no result object here"}]
JSON
check "execution file without a result object fails" 1 "$root/no-result.json"

[ "$fail" -eq 0 ] && echo "verify-claude-run-status.test.sh: all cases passed" || { echo "verify-claude-run-status.test.sh: FAILURES"; exit 1; }
