#!/bin/bash

set -euo pipefail

echo "Checking workspace dependency policy..."
violations=0

while IFS= read -r manifest; do
  offending_deps=$(jq -r \
    '(.dependencies // {}) + (.devDependencies // {}) | keys[] | select(startswith("@agent-lcars/") | not)' \
    "$manifest")
  if [ -n "$offending_deps" ]; then
    echo "External dependencies must be declared in the root package.json: $manifest"
    echo "$offending_deps" | sed 's/^/  - /'
    violations=$((violations + 1))
  fi
# The two pnpm-store directories are standalone Docker build inputs, not Nx
# workspaces. Their exact dependency sets are intentionally curated for the
# runner image and locked independently of the application workspace; folding
# them into the root dependency policy would couple seed refreshes to consumer
# lockfile churn. Keep this exception path-specific rather than treating all
# nested/private package manifests as exempt.
done < <(
  find apps libs -name package.json -not -path '*/dist/*' \
    -not -path 'apps/runner-autoscaler/runner-image/pnpm-seed/*' \
    -not -path 'apps/runner-autoscaler/runner-image/pnpm-seed-regression/*' | sort
)

if [ "$violations" -ne 0 ]; then
  exit 1
fi

# The shared pnpm lockfile/tree behavior is owned by public repo-tools. This
# repository keeps only its @agent-lcars workspace policy above.
pnpm exec repo-check-dependencies
