#!/bin/bash

set -euo pipefail

echo "Checking workspace dependency policy..."
violations=0

while IFS= read -r manifest; do
  offending_deps=$(jq -r \
    '(.dependencies // {}) + (.devDependencies // {}) | keys[] | select((startswith("@repo/") or startswith("@agent-lcars/")) | not)' \
    "$manifest")
  if [ -n "$offending_deps" ]; then
    echo "External dependencies must be declared in the root package.json: $manifest"
    echo "$offending_deps" | sed 's/^/  - /'
    violations=$((violations + 1))
  fi
done < <(find apps libs -name package.json -not -path '*/dist/*' | sort)

if [ "$violations" -ne 0 ]; then
  exit 1
fi

echo "Checking frozen lockfile..."
pnpm install --frozen-lockfile --lockfile-only --ignore-scripts

echo "Checking dependency tree..."
tree_output=$(pnpm ls --depth=10 2>&1 || true)
if echo "$tree_output" | grep -Eq 'invalid:|missing:'; then
  echo "$tree_output"
  exit 1
fi

echo "Dependency checks passed."
