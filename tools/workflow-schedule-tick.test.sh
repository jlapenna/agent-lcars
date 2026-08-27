#!/usr/bin/env bash
# The scheduled tick trigger must exist, run on a 5-minute cadence plus
# workflow_dispatch, request only id-token: write, and call the control
# plane at the schedules tick endpoint with the schedule-tick audience and
# an explicit empty-object payload (never a truly bodyless POST -- the
# tick procedure's input schema expects valid JSON). Pure text assertions
# on the YAML -- no git, no GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
f=.github/workflows/work-schedules-tick.yml
[ -f "$f" ] || { echo "$f: missing"; exit 1; }
grep -q "cron: '\*/5 \* \* \* \*'" "$f" || { echo "$f: expected a 5-minute schedule"; fail=1; }
grep -q "workflow_dispatch:" "$f" || { echo "$f: missing workflow_dispatch trigger"; fail=1; }
grep -q "^permissions: {}$" "$f" || { echo "$f: top-level permissions must be {}"; fail=1; }
grep -q "id-token: write" "$f" || { echo "$f: job must grant id-token: write"; fail=1; }
grep -q "request-control-plane@main" "$f" || { echo "$f: must call request-control-plane"; fail=1; }
grep -q "endpoint: https://lcars.jlapenna.net/api/work/v1/schedules/tick" "$f" || { echo "$f: wrong endpoint"; fail=1; }
grep -q "audience: agent-lcars-work-schedules" "$f" || { echo "$f: wrong audience"; fail=1; }
grep -q "payload: '{}'" "$f" || { echo "$f: must POST an explicit empty JSON object"; fail=1; }
exit $fail
