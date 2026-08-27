#!/usr/bin/env bash
# The session-pin reaper's scheduled workflow must exist, run on the
# dispatch-reconcile-matching 30-minute-offset cadence plus
# workflow_dispatch, request id-token: write, mint a bearer for the
# session-pin-tick audience, impersonate the telemetry writer as an
# access token, and invoke the pin sweep script. Pure text assertions on
# the YAML -- no git, no GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
f=.github/workflows/work-session-pin-tick.yml
[ -f "$f" ] || { echo "$f: missing"; exit 1; }
grep -q "cron: '17,47 \* \* \* \*'" "$f" || { echo "$f: expected the dispatch-reconcile-matching 30-minute-offset cadence"; fail=1; }
grep -q 'workflow_dispatch:' "$f" || { echo "$f: missing workflow_dispatch trigger"; fail=1; }
grep -q 'id-token: write' "$f" || { echo "$f: missing id-token: write permission"; fail=1; }
grep -q 'audience=agent-lcars-session-pin-tick' "$f" || { echo "$f: wrong or missing read audience"; fail=1; }
grep -q 'token_format: access_token' "$f" || { echo "$f: missing write token_format: access_token"; fail=1; }
grep -q 'session-pin-tick.ts' "$f" || { echo "$f: missing script invocation"; fail=1; }
exit $fail
