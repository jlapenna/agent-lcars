#!/usr/bin/env bash
# Ensure this checkout's Husky bootstrap exists before relying on its guards.
set -euo pipefail

hooks_path="$(git config --get core.hooksPath || true)"
if [ "$hooks_path" != ".husky/_" ]; then
  display_path="${hooks_path:-unset}"
  echo "ERROR: expected core.hooksPath to be .husky/_; found $display_path." >&2
  exit 1
fi

if [ ! -f .husky/_/h ]; then
  echo "ERROR: missing Husky bootstrap .husky/_/h. Run pnpm exec husky." >&2
  exit 1
fi

for hook in pre-commit pre-push; do
  if [ ! -x ".husky/_/$hook" ]; then
    echo "ERROR: missing executable Husky bootstrap .husky/_/$hook. Run pnpm exec husky." >&2
    exit 1
  fi
done

echo "Git hooks are installed."
