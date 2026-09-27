#!/usr/bin/env bash
# Decide whether a CI-validated revision would move production backwards.
#
# Usage: tools/deploy-console-superseded.sh <owner/repo> <source-sha>
# Prints `superseded=true|false` (GITHUB_OUTPUT format) and the reason on
# stderr.
#
# main's CI runs concurrently (one concurrency group per commit), so their
# `workflow_run` completions, and the deploy-console runs they trigger, can
# arrive out of merge order. deploy-console runs are serialized, so at this
# point the newest successful `deploy` job is what production serves. A
# revision that is that one, or an ancestor of it, is superseded: deploying
# it would roll production back. Anything newer (or unrelated history) is
# deployed as before, so every green commit still ships in order unless a
# newer one already has.
set -euo pipefail

repository="$1"
source_sha="$2"

deployed_sha=""
while read -r run_id title; do
  deploy_conclusion="$(gh api "repos/${repository}/actions/runs/${run_id}/jobs" \
    --jq '.jobs[] | select(.name == "deploy") | .conclusion')"
  if [[ "$deploy_conclusion" == success ]]; then
    deployed_sha="$(sed -nE 's/.*\[source:([0-9a-f]{40})\].*/\1/p' <<<"$title")"
    [[ -n "$deployed_sha" ]] && break
  fi
done < <(gh api "repos/${repository}/actions/workflows/deploy-console.yml/runs?status=success&per_page=20" \
  --jq '.workflow_runs[] | "\(.id) \(.display_title)"')

if [[ -z "$deployed_sha" ]]; then
  echo "No successful console deploy found; deploying ${source_sha}." >&2
  echo "superseded=false"
  exit 0
fi

status="$(gh api "repos/${repository}/compare/${deployed_sha}...${source_sha}" --jq .status)"
case "$status" in
  behind | identical)
    echo "Production already serves ${deployed_sha}; ${source_sha} is ${status}, skipping." >&2
    echo "superseded=true"
    ;;
  ahead | diverged)
    echo "${source_sha} is ${status} of deployed ${deployed_sha}; deploying." >&2
    echo "superseded=false"
    ;;
  *)
    echo "Unexpected compare status '${status}' for ${deployed_sha}...${source_sha}." >&2
    exit 1
    ;;
esac
