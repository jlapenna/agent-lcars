#!/usr/bin/env bash
# Every worker workflow must accept either anchor: `issue` optional, a
# `work` input, and job gates that admit `work` alone. Pure text
# assertions on the YAML -- no git, no GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
for wf in claude codex opencode; do
  f=".github/workflows/$wf.yml"
  grep -Pzo "issue:\n\s+description:[^\n]*\n\s+required: false" "$f" >/dev/null || { echo "$f: issue must be required: false"; fail=1; }
  grep -q "^      work:$" "$f" || { echo "$f: missing work input"; fail=1; }
  n=$(grep -c "inputs.issue != '' || inputs.work != ''" "$f" || true)
  [ "$n" -ge 2 ] || { echo "$f: expected both job gates to accept either anchor (found $n)"; fail=1; }
  count=$(awk '/workflow_dispatch:/{f=1} f&&/^      [a-z_]+:$/{n++} /^jobs:/{exit} END{print n}' "$f")
  [ "$count" -le 10 ] || { echo "$f: $count inputs exceeds GitHub's limit of 10"; fail=1; }
done
grep -q "inputs.work" ".github/workflows/agent-fallback-finalize.yml" || { echo "finalizer must receive work"; fail=1; }

# agent-lane.yml's own issue-reading steps (Task 3): the claim step, both
# prepare-agent-dispatch calls, and the sidecar's INTENT_ID passthrough must
# all admit a work-anchored (native) run alongside an issue-anchored one.
lane=.github/workflows/agent-lane.yml
grep -q "work: \${{ inputs.work }}" "$lane" || { echo "lane: prepare-agent-dispatch must receive work"; fail=1; }
grep -Pzo "Claim the issue as the agent fleet\n(\s+#[^\n]*\n)*\s+if: [^\n]*inputs\.issue != ''" "$lane" >/dev/null || { echo "lane: claim step must be gated on issue"; fail=1; }
grep -q "INTENT_ID: \${{ inputs.broker-intent-id }}" "$lane" || { echo "lane: sidecar must receive INTENT_ID"; fail=1; }

# dispatch-bootstrap's own claim step (the dispatch-bootstrap-era mirror of
# the lane's consumer-era claim step above) has no dedicated test file, so
# its issue gate is asserted here per the workflow contract test fallback.
bootstrap=.github/actions/dispatch-bootstrap/action.yml
sed -n '/Claim the issue as the agent fleet/,$p' "$bootstrap" | grep -q "if: inputs\.issue != ''" || { echo "dispatch-bootstrap: claim step must be gated on issue"; fail=1; }

# telemetry-start's issue input must be optional: a native run passes ''.
grep -Pzo "issue:\n\s+description:[^\n]*\n\s+required: false" .github/actions/telemetry-start/action.yml >/dev/null || { echo "telemetry-start: issue must be required: false"; fail=1; }

# agent-fallback-finalize.yml's bootstrap-independent fallback steps ("Report
# and park.../Preserve failed callback...") must tolerate a native run: they
# receive WORK and warn (never hard-exit) when ISSUE is empty.
finalize=.github/workflows/agent-fallback-finalize.yml
n=$(grep -c "WORK: \${{ inputs.work }}" "$finalize" || true)
[ "$n" -ge 3 ] || { echo "finalize: park/preserve fallback steps must receive WORK (found $n, need >=3)"; fail=1; }
grep -q '::warning::.*[Nn]ative work item' "$finalize" || { echo "finalize: fallback steps must warn (not exit 1) for a native run with no issue anchor"; fail=1; }

exit $fail
