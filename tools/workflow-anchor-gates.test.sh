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
  grep -q "inputs.work" ".github/workflows/agent-fallback-finalize.yml" || { echo "finalizer must receive work"; fail=1; }
  count=$(awk '/workflow_dispatch:/{f=1} f&&/^      [a-z_]+:$/{n++} /^jobs:/{exit} END{print n}' "$f")
  [ "$count" -le 10 ] || { echo "$f: $count inputs exceeds GitHub's limit of 10"; fail=1; }
done
exit $fail
