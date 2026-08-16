#!/usr/bin/env bash
# Independent guard against a Claude Code run that crashed during
# initialization: it errored (or got a 401) AND spent nothing. The action
# itself already fails is_error:true results; this exists to catch a missing
# execution file or a future silent-green regression.
#
# Extracted from claude.yml inline bash (#1283) so it can carry a regression
# test. The bug it replaces was invisible from the outside: a healthy 0.76 USD
# run was failed as a silent startup crash.
#
# Two substring defects, both fixed by reading typed JSON instead:
#
#   1. `grep -q '"total_cost_usd": 0'` matches "total_cost_usd": 0.7592557.
#      It expressed "cost starts with the digit 0", not "cost is zero", so
#      every run under a dollar satisfied that half of the condition.
#
#   2. The execution file embeds the agent's own transcript, so any text the
#      agent read or printed could satisfy the other half. The run that
#      exposed this had merely READ claude.yml, pulling the literal string
#      '"is_error": true' out of the old guard and into its transcript.
#      A gate that fails because an agent inspected it punishes exactly the
#      diligence it should reward.
#
# jq traversal fixes both: it walks parsed structure, so text quoted inside a
# string is never a candidate -- the property substring search lacks -- and a
# number is compared as a number.
set -uo pipefail

FILE="${1:?usage: verify-claude-run-status.sh <execution-file>}"

if [ ! -r "$FILE" ]; then
  echo "::error::Claude Code Action did not publish its structured execution file."
  exit 1
fi

result="$(jq -c 'first(.. | objects | select(has("total_cost_usd") and has("is_error")))' "$FILE" 2>/dev/null)"
if [ -z "$result" ] || [ "$result" = null ]; then
  echo "::error::Claude Code execution file has no result object carrying total_cost_usd and is_error."
  exit 1
fi

cost="$(printf '%s' "$result" | jq -r '.total_cost_usd')"
is_error="$(printf '%s' "$result" | jq -r '.is_error')"
api_error_status="$(printf '%s' "$result" | jq -r '.api_error_status // empty')"
spent_nothing="$(jq -n --argjson c "$cost" '$c == 0' 2>/dev/null || echo false)"

if { [ "$api_error_status" = "401" ] || [ "$is_error" = "true" ]; } && [ "$spent_nothing" = "true" ]; then
  echo "::error::Claude Code run failed silently during startup/authentication (is_error=$is_error api_error_status=${api_error_status:-none} cost=$cost)."
  exit 1
fi
exit 0
