#!/usr/bin/env bash
# Write .nx-remote-cache.env so tools/nx can enable the self-hosted Nx remote
# cache -- the "L2" server on spark that CI uses too. Safe to re-run.
#
# The credential is resolved from two sources, first hit wins:
#
#   1. The encrypted age secret store (secrets-cat / NX_CACHE_TOKEN_SPARK).
#      Covers the maintainer's home directory on any fleet host, with no cloud
#      login required.
#   2. This repo's own GCP project. Covers runs that do NOT happen in that home
#      directory -- CI containers, self-hosted runners, and any host that has
#      workload identity but no age key.
#
# The project is passed explicitly and is never inherited from `gcloud config`.
# An ambient default belongs to whatever the developer last worked on, so a
# bare `gcloud secrets access` here would quietly read the wrong project and
# either fail or hand back some other product's secret.
#
# Only the primary checkout holds the file. tools/nx resolves a linked
# worktree's config by reading through to the primary, so a per-worktree copy
# would only add a second credential on disk that can go stale across a
# rotation.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
PRIMARY_ROOT="$(dirname "$GIT_COMMON_DIR")"
if [ "$PRIMARY_ROOT" != "$ROOT" ]; then
  echo "==> Linked worktree detected. tools/nx reads the primary checkout's"
  echo "    config directly, so run this there instead:"
  echo "        (cd $PRIMARY_ROOT && ./tools/setup-nx-remote-cache.sh)"
  exit 0
fi

GCP_PROJECT_ID="${GCP_PROJECT_ID:-agent-lcars}"
NX_REMOTE_CACHE_URL="${NX_REMOTE_CACHE_URL:-http://spark.lan.jlapenna.net:3123}"
SECRET_NAME="${NX_CACHE_SECRET_NAME:-nx-cache-access-token}"
ENV_FILE=.nx-remote-cache.env

if [ -f "$ENV_FILE" ] && [ "${1:-}" != "--force" ]; then
  echo "==> $ENV_FILE already present; pass --force to rewrite it (rotation)."
  exit 0
fi

# A source is only usable if its token actually authenticates. Checking mere
# presence is not enough: a stale value in one store outranks a working value
# in the next, and nx fails OPEN on a rejected token -- every request 403s and
# the build silently degrades to local recomputation with no error anywhere.
# That is the least visible way this can break, so probe before committing.
#
# GET /v1/cache/<hash> on an absent hash: 404 means the bearer token was
# accepted, 403 means it was refused. Any other status (or an unreachable
# server) is inconclusive, so treat it as usable and let tools/nx's own
# reachability probe decide at run time.
token_authenticates() {
  local candidate="$1" code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    -H "Authorization: Bearer $candidate" \
    "$NX_REMOTE_CACHE_URL/v1/cache/authprobe000000000000000000000" 2>/dev/null || true)"
  [ "$code" != "403" ]
}

token=""
source_used=""
rejected=""

try_source() {
  local candidate="$1" label="$2"
  [ -n "$token" ] && return 0
  [ -z "$candidate" ] && return 0
  if token_authenticates "$candidate"; then
    token="$candidate"
    source_used="$label"
  else
    rejected="${rejected}    - ${label}: token refused (403)\n"
  fi
}

# 1. Encrypted age store -- maintainer workstations, no cloud login needed.
if command -v secrets-cat >/dev/null 2>&1; then
  try_source \
    "$(secrets-cat 2>/dev/null | sed -n 's/^NX_CACHE_TOKEN_SPARK=//p' | tail -1)" \
    "the age secret store (NX_CACHE_TOKEN_SPARK)"
fi

# 2. This repo's own GCP project -- explicit --project, never ambient.
if command -v gcloud >/dev/null 2>&1; then
  try_source \
    "$(gcloud secrets versions access latest \
      --secret="$SECRET_NAME" \
      --project="$GCP_PROJECT_ID" 2>/dev/null || true)" \
    "gcloud secret $SECRET_NAME in $GCP_PROJECT_ID"
fi

if [ -z "$token" ]; then
  echo "⚠️  No working Nx cache credential found." >&2
  if [ -n "$rejected" ]; then
    echo "    Sources tried and refused by $NX_REMOTE_CACHE_URL:" >&2
    printf "$rejected" >&2
  else
    echo "    No source produced a credential (age store and $SECRET_NAME" >&2
    echo "    in $GCP_PROJECT_ID were both empty or unavailable)." >&2
  fi
  echo "    Skipping remote cache setup. Builds still work -- they just" >&2
  echo "    recompute locally instead of pulling from spark." >&2
  exit 0
fi

# umask before create so the token is never briefly group/world readable.
umask 077
printf 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER=%s\nNX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=%s\n' \
  "$NX_REMOTE_CACHE_URL" "$token" >"$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "✅ Wrote $ENV_FILE from $source_used."
echo "   Server: $NX_REMOTE_CACHE_URL"
