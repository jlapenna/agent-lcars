#!/usr/bin/env bash
# Package the locked Anthropic code-review command for the runner image; never
# resolve or download a new version. `pnpm install --frozen-lockfile` installs
# the dependency this package declares, verified against the lockfile's
# integrity hash; this script copies the command, its license, the pinned
# upstream commit and the rendered LCARS adapter into one directory.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
destination="${1:?usage: package-review.sh <output-directory>}"
dependency='@anthropics/claude-plugins-official'

revision="$(node -e '
  const spec = require(process.argv[1]).dependencies?.[process.argv[2]] ?? "";
  const match = /^github:anthropics\/claude-plugins-official#([0-9a-f]{40})$/.exec(spec);
  if (!match) process.exit(1);
  console.log(match[1]);
' "$here/package.json" "$dependency")" || {
  echo "Anthropic review dependency must pin $dependency to a full upstream commit" >&2
  exit 1
}
if ! grep -Fq "codeload.github.com/anthropics/claude-plugins-official/tar.gz/$revision" "$repo_root/pnpm-lock.yaml"; then
  echo 'Anthropic review dependency is not at its locked revision; run pnpm install' >&2
  exit 1
fi
source_dir="$here/node_modules/$dependency/plugins/code-review"
for source_file in commands/code-review.md LICENSE; do
  if [ ! -s "$source_dir/$source_file" ]; then
    echo "Anthropic review dependency is missing $source_file; run pnpm install --frozen-lockfile" >&2
    exit 1
  fi
done

mkdir -p "$destination"
cp "$source_dir/commands/code-review.md" "$destination/upstream.md"
cp "$source_dir/LICENSE" "$destination/LICENSE"
printf '%s\n' "$revision" > "$destination/revision"
adapter="$repo_root/agents/shared/skills/agent-protocol/reference/anthropic-code-review/README.md"
sed "s/@ANTHROPIC_REVIEW_REVISION@/$revision/g" "$adapter" > "$destination/README.md"
