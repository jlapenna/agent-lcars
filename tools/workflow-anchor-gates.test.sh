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

# agent-lane.yml's own issue-reading steps (Task 3): both prepare-agent-
# dispatch calls and the sidecar's INTENT_ID passthrough must all admit a
# work-anchored (native) run alongside an issue-anchored one.
lane=.github/workflows/agent-lane.yml
grep -q "work: \${{ inputs.work }}" "$lane" || { echo "lane: prepare-agent-dispatch must receive work"; fail=1; }
grep -q "INTENT_ID: \${{ inputs.broker-intent-id }}" "$lane" || { echo "lane: sidecar must receive INTENT_ID"; fail=1; }

# The lane's own claim step was deleted (agent-lcars#1544/#1557): the
# console claims every GitHub-anchored dispatch itself
# (orchestrator-dispatch.ts's claimGithubAnchor) now that a hand-run
# workflow_dispatch is a retired escape hatch -- assert it stays gone
# rather than pinning a gate on it.
grep -q "^      - name: Claim the issue as the agent fleet$" "$lane" && { echo "lane: claim step should stay deleted (console projects the claim)"; fail=1; }

# dispatch-bootstrap's own claim step was deleted earlier still (agent-lcars
# own workers always ran dispatch-bootstrap under the console, so the
# step's gate was never reachable) -- assert it stays gone rather than
# pinning a gate on it.
bootstrap=.github/actions/dispatch-bootstrap/action.yml
grep -q "^    - name: Claim the issue as the agent fleet$" "$bootstrap" && { echo "dispatch-bootstrap: claim step should stay deleted (console projects the claim)"; fail=1; }

# telemetry-start's issue input must be optional: a native run passes ''.
grep -Pzo "issue:\n\s+description:[^\n]*\n\s+required: false" .github/actions/telemetry-start/action.yml >/dev/null || { echo "telemetry-start: issue must be required: false"; fail=1; }

# agent-fallback-finalize.yml's bootstrap-independent fallback steps ("Report
# and park.../Preserve failed callback...") must tolerate a native run: they
# receive WORK and warn (never hard-exit) when ISSUE is empty.
finalize=.github/workflows/agent-fallback-finalize.yml
n=$(grep -c "WORK: \${{ inputs.work }}" "$finalize" || true)
[ "$n" -ge 3 ] || { echo "finalize: park/preserve fallback steps must receive WORK (found $n, need >=3)"; fail=1; }
grep -q '::warning::.*[Nn]ative work item' "$finalize" || { echo "finalize: fallback steps must warn (not exit 1) for a native run with no issue anchor"; fail=1; }

# C1 regression: `uses: ./.github/actions/...` resolves against the
# CALLER's checkout in a reusable workflow -- fine for a step gated to an
# agent-lcars-only era (this repo's own dispatch-bootstrap checkout, or
# opencode's own trajectory-export step), but any other local `uses:` in
# this lane silently breaks every consumer repo that calls the lane at
# `@main`, since they don't carry this repo's `.github/actions/*`
# directories. Every local action step's own `if:` must therefore gate on
# `inputs.dispatch-bootstrap` or `inputs.trajectory-export` -- the two eras
# that actually check out this repo's action directories.
#
# The gate must be POSITIVE. A negated one (`!inputs.dispatch-bootstrap`)
# runs the local `uses: ./...` in precisely the consumer era it must never
# run in -- the original C1 bug, reintroduced by inverting rather than
# deleting the condition. Substring presence alone cannot tell the two
# apart, so strip the negated forms before testing for the positive token.
awk '
  /^      - name:/ { ifline = "" }
  /^        if:/ { ifline = $0 }
  /^        uses: \.\/\.github\/actions\// {
    probe = ifline
    gsub(/![[:space:]]*inputs\.dispatch-bootstrap/, "", probe)
    gsub(/![[:space:]]*inputs\.trajectory-export/, "", probe)
    if (probe !~ /inputs\.dispatch-bootstrap/ && probe !~ /inputs\.trajectory-export/) {
      print "lane: local action step not gated to an agent-lcars-only era (" $0 ")"
      bad = 1
    }
  }
  END { if (bad) exit 1 }
' "$lane" || fail=1

# The `control-plane-projections` provenance-derivation regression this
# block used to pin (jlapenna/homelab#906: a literal `true` made the lane
# skip its own claim step even on a hand-run dispatch) is moot now that the
# input itself is gone (agent-lcars#1544/#1557) -- a hand-run
# `workflow_dispatch` is a retired escape hatch by policy, and the console
# claims every GitHub-anchored dispatch itself regardless. Assert the input
# stays deleted from this repo's own callers rather than pinning a
# derivation rule that no longer applies.
for wf in claude codex opencode; do
  f=".github/workflows/$wf.yml"
  grep -q "control-plane-projections:" "$f" && { echo "$f: control-plane-projections should stay deleted (legacy claim path removed)"; fail=1; }
done

exit $fail
