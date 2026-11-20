#!/usr/bin/env bash
# Package the locked source dependency; never resolve or download a new version.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
dependency=third_party/anthropic-plugins
source_dir="$repo_root/$dependency"
destination="${1:?usage: package-anthropic-review.sh <output-directory>}"
expected="$(git -C "$repo_root" rev-parse ":$dependency")"
actual="$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)"
if [ "$actual" != "$expected" ]; then
  echo 'Anthropic review dependency is not at its locked revision; run git submodule update --init --depth 1 -- third_party/anthropic-plugins' >&2
  exit 1
fi
git -C "$source_dir" diff --exit-code HEAD -- plugins/code-review >/dev/null || {
  echo 'Anthropic review dependency has modified source files' >&2
  exit 1
}
mkdir -p "$destination"
cp "$source_dir/plugins/code-review/commands/code-review.md" "$destination/upstream.md"
cp "$source_dir/plugins/code-review/LICENSE" "$destination/LICENSE"
printf '%s\n' "$actual" > "$destination/revision"
adapter="$repo_root/agents/shared/skills/agent-protocol/reference/anthropic-code-review/README.md"
sed "s/@ANTHROPIC_REVIEW_REVISION@/$actual/g" "$adapter" > "$destination/README.md"
