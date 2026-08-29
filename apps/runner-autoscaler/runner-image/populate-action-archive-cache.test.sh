#!/usr/bin/env bash
# Hermetic contract for populate-action-archive-cache.sh's scan/dedup logic
# (no network): SHA pins and tag refs are both emitted, subdir actions
# collapse to owner_repo, local ./ actions and reusable-workflow refs are
# excluded, and the 40-hex fast path in resolve_commit needs no git.
set -euo pipefail
cd "$(dirname "$0")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/repo/.github/workflows" "$tmp/repo/.github/actions/local-thing"
cat > "$tmp/repo/.github/workflows/a.yml" <<'YML'
jobs:
  j:
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v6
      - uses: actions/setup-go@v7
      - uses: ./.github/actions/local-thing
      - uses: actions/codeql-action/init@abc1234def5678901234abc1234def5678901234
  caller:
    uses: jlapenna/agent-lcars/.github/workflows/repo-validation.yml@main
YML
cat > "$tmp/repo/.github/actions/local-thing/action.yml" <<'YML'
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v7
    - uses: actions/setup-go@v7
YML

got="$(./populate-action-archive-cache.sh --list "$tmp/repo")"
expected="actions_checkout 3d3c42e5aac5ba805825da76410c181273ba90b1
actions_codeql-action abc1234def5678901234abc1234def5678901234
actions_setup-go v7
actions_setup-node v7"
if [ "$got" != "$expected" ]; then
  echo "FAIL: scan output mismatch" >&2
  diff <(echo "$expected") <(echo "$got") >&2 || true
  exit 1
fi

# 40-hex refs must resolve without any network/git call.
sha="face1234face1234face1234face1234face1234"
resolved="$(bash -c '
  set -euo pipefail
  source /dev/stdin <<SRC
$(sed -n "/^resolve_commit()/,/^}/p" populate-action-archive-cache.sh)
SRC
  GIT_TERMINAL_PROMPT=0 PATH=/nonexistent resolve_commit owner repo '"$sha"'
')"
if [ "$resolved" != "$sha" ]; then
  echo "FAIL: hex fast path returned '$resolved'" >&2
  exit 1
fi

echo "populate-action-archive-cache: OK"
