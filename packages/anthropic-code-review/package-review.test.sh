#!/usr/bin/env bash
# package-review.sh packages only the dependency revision the lockfile pins.
# Fixtures stand in for the installed dependency and lockfile, so this runs in
# any checkout without network access or `pnpm install`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "package-review: $1" >&2
  exit 1
}

revision=0123456789abcdef0123456789abcdef01234567
adapter_relpath=agents/shared/skills/agent-protocol/reference/anthropic-code-review/README.md

# A repository tree holding the packager, its manifest, the adapter, a lockfile
# and an installed dependency.
make_fixture() {
  local fixture="$1" spec="$2" locked="$3" package="$1/packages/anthropic-code-review"
  local installed="$package/node_modules/@anthropics/claude-plugins-official/plugins/code-review"
  mkdir -p "$installed/commands" "$(dirname "$fixture/$adapter_relpath")"
  cp "$here/package-review.sh" "$package/"
  cp "$repo_root/$adapter_relpath" "$fixture/$adapter_relpath"
  printf '{"dependencies":{"@anthropics/claude-plugins-official":"%s"}}\n' "$spec" > "$package/package.json"
  printf "    resolution: {gitHosted: true, tarball: https://codeload.github.com/anthropics/claude-plugins-official/tar.gz/%s}\n" "$locked" > "$fixture/pnpm-lock.yaml"
  printf '%s\n' '# fixture code-review command' > "$installed/commands/code-review.md"
  printf '%s\n' 'fixture license' > "$installed/LICENSE"
}

expect_refusal() {
  local label="$1" fixture="$2" message="$3"
  if bash "$fixture/packages/anthropic-code-review/package-review.sh" "$tmp/$label-out" > "$tmp/$label.err" 2>&1; then
    fail "$label: packaging was accepted"
  fi
  grep -Fq "$message" "$tmp/$label.err" || fail "$label: expected '$message' ($(cat "$tmp/$label.err"))"
}

locked="$tmp/locked"
make_fixture "$locked" "github:anthropics/claude-plugins-official#$revision" "$revision"
out="$tmp/out"
bash "$locked/packages/anthropic-code-review/package-review.sh" "$out" || fail 'locked dependency was refused'
installed="$locked/packages/anthropic-code-review/node_modules/@anthropics/claude-plugins-official/plugins/code-review"
cmp "$installed/commands/code-review.md" "$out/upstream.md" || fail 'upstream command differs'
cmp "$installed/LICENSE" "$out/LICENSE" || fail 'license differs'
[ "$(cat "$out/revision")" = "$revision" ] || fail 'revision was not recorded'
grep -Fq "$revision" "$out/README.md" || fail 'adapter does not name the revision'
if grep -Fq '@ANTHROPIC_REVIEW_REVISION@' "$out/README.md"; then fail 'adapter placeholder was left unrendered'; fi

# The manifest must pin a full commit, never a branch, tag or short hash.
for spec in 'github:anthropics/claude-plugins-official#main' \
  'github:anthropics/claude-plugins-official#0123456' \
  'github:someone/claude-plugins-official#0123456789abcdef0123456789abcdef01234567'; do
  unpinned="$tmp/unpinned-${#spec}"
  make_fixture "$unpinned" "$spec" "$revision"
  expect_refusal "unpinned-${#spec}" "$unpinned" 'to a full upstream commit'
done

# A manifest the lockfile has not caught up with must never package.
stale="$tmp/stale"
make_fixture "$stale" "github:anthropics/claude-plugins-official#$revision" 1111111111111111111111111111111111111111
expect_refusal stale "$stale" 'not at its locked revision'

# An uninstalled dependency must never package.
missing="$tmp/missing"
make_fixture "$missing" "github:anthropics/claude-plugins-official#$revision" "$revision"
rm "$missing/packages/anthropic-code-review/node_modules/@anthropics/claude-plugins-official/plugins/code-review/LICENSE"
expect_refusal missing "$missing" 'missing LICENSE'

echo 'package-review.test.sh: all cases passed'
