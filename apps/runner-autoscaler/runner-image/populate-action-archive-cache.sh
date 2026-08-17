#!/usr/bin/env bash
# Pre-populate the Actions runner's action-archive cache (agent-lcars#1330).
#
# The runner downloads every `uses:` action tarball from codeload.github.com
# at job setup — even on self-hosted runners, and ephemeral JIT runners keep
# no cache between jobs, so a codeload outage fails jobs before their first
# step (seven consecutive Set-up-job failures on 2026-08-17). The runner
# consults ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE first: a directory of
# {owner}_{repo}/{commit-sha}.tar.gz archives, looked up by the commit SHA
# the runner resolved for the job's ref.
#
# The archive list derives from the repository checkout itself — every
# `uses: owner/repo[/path]@ref` across workflows and composite actions — so
# the cache is self-maintaining: the image builds from fresh main and bakes
# exactly what current main references, no hand-kept pin list to rot.
# 40-hex refs are cached directly; tag/branch refs are resolved to their
# commit SHA at build time via `git ls-remote` (peeled), so a tag that moves
# after the image builds simply misses the cache and falls back to codeload,
# i.e. today's behavior. Reusable-workflow refs (owner/repo/.github/
# workflows/...) and local ./ actions are skipped — the archive cache serves
# remote actions only.
#
# Usage:
#   populate-action-archive-cache.sh <repo-root> <out-dir>   # resolve + download
#   populate-action-archive-cache.sh --list <repo-root>      # print "owner_repo ref" (no network)
set -euo pipefail

list_only=false
if [ "${1:-}" = "--list" ]; then
  list_only=true
  shift
fi
repo_root="$1"
out_dir="${2:-}"
if ! $list_only && [ -z "$out_dir" ]; then
  echo "usage: $0 [--list] <repo-root> <out-dir>" >&2
  exit 64
fi

scan() {
  # Emits unique "owner_repo ref" pairs for every remote action use.
  find "$repo_root/.github/workflows" "$repo_root/.github/actions" \
    \( -name '*.yml' -o -name '*.yaml' \) -print 2>/dev/null |
    xargs -r grep -hoE "uses:[[:space:]]*[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[^@[:space:]]+)?@[A-Za-z0-9_./-]+" |
    sed -E 's/^uses:[[:space:]]*//' |
    grep -v '/\.github/workflows/' |
    sed -E 's#^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(/[^@]+)?@#\1_\2 #' |
    sort -u
}

resolve_commit() {
  # 40-hex ref: already a commit. Otherwise resolve tag (peeled if
  # annotated) or branch to a commit SHA.
  local owner="$1" repo="$2" ref="$3" out
  if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$ref"
    return 0
  fi
  out="$(git ls-remote "https://github.com/$owner/$repo" \
    "refs/tags/$ref" "refs/tags/$ref^{}" "refs/heads/$ref" 2>/dev/null)" || return 1
  # Prefer the peeled tag object (the commit), then any match.
  awk -v peeled="refs/tags/$ref^{}" '$2 == peeled {print $1; found=1; exit} END {exit !found}' <<<"$out" ||
    awk 'NR==1 {print $1; found=1} END {exit !found}' <<<"$out"
}

if $list_only; then
  scan
  exit 0
fi

mkdir -p "$out_dir"
failures=0
while read -r dir ref; do
  [ -n "$dir" ] || continue
  owner="${dir%%_*}"
  repo="${dir#*_}"
  if ! sha="$(resolve_commit "$owner" "$repo" "$ref")"; then
    echo "FAILED to resolve $owner/$repo@$ref" >&2
    failures=$((failures + 1))
    continue
  fi
  dest="$out_dir/$dir/$sha.tar.gz"
  [ -f "$dest" ] && continue
  mkdir -p "$out_dir/$dir"
  echo "caching $owner/$repo@$ref -> $sha"
  if ! curl -fsSL --retry 5 --retry-all-errors --retry-delay 10 \
    "https://codeload.github.com/$owner/$repo/tar.gz/$sha" -o "$dest"; then
    echo "FAILED to cache $owner/$repo@$sha" >&2
    rm -f "$dest"
    failures=$((failures + 1))
  fi
done < <(scan)

if [ "$failures" -gt 0 ]; then
  # A build must not ship a partial cache silently: a runtime miss just
  # falls back to codeload, but a failure here means the build ran during
  # an outage — fail it so the published image is never quietly less
  # resilient than the one it replaces.
  echo "action-archive-cache: $failures failure(s)" >&2
  exit 1
fi
echo "action-archive-cache: $(find "$out_dir" -name '*.tar.gz' | wc -l) archives in $out_dir"
