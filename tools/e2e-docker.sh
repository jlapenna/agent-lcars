#!/bin/bash
# Runs an e2e project's `e2e` target inside the pinned Docker environment
# (tools/e2e/Dockerfile) instead of on the host. Screenshot baselines
# (@visual specs) are sensitive to the OS font rasterizer and exact browser
# build, so rendering inside this image makes local runs match CI
# byte-for-byte -- and apps/console-e2e/playwright.config.ts auto-skips
# @visual specs entirely outside of CI/Docker for exactly this reason.
#
# Usage:
#   tools/e2e-docker.sh <nx-project> [--update]
#
#   <nx-project>  e.g. @agent-lcars/console-e2e
#   --update      sets UPDATE_SNAPSHOTS=1 so playwright.config.ts passes
#                 `updateSnapshots: 'all'`, writing new/changed @visual
#                 baselines back to the host checkout via the bind mount
#                 below, instead of just diffing against the existing ones.
#
# The image tag is derived from the Dockerfile's own content hash (see its
# header comment), so editing that file always invalidates stale images here
# and in CI without any separate version bump to remember.

set -euo pipefail

PROJECT="${1:?usage: tools/e2e-docker.sh <nx-project> [--update]}"
MODE="${2:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$REPO_ROOT/tools/e2e/Dockerfile"
IMAGE_TAG="agent-lcars-e2e:$(sha256sum "$DOCKERFILE" | cut -c1-12)"

if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "tools/e2e-docker.sh: building $IMAGE_TAG"
  docker build -t "$IMAGE_TAG" -f "$DOCKERFILE" "$REPO_ROOT/tools/e2e"
fi

DOCKER_ENV_ARGS=(--env CI=1)
if [ "$MODE" = "--update" ]; then
  DOCKER_ENV_ARGS+=(--env UPDATE_SNAPSHOTS=1)
elif [ -n "$MODE" ]; then
  echo "tools/e2e-docker.sh: unrecognized mode '$MODE' (expected --update or nothing)" >&2
  exit 1
fi

echo "tools/e2e-docker.sh: running $PROJECT:e2e inside $IMAGE_TAG"
docker run --rm \
  --env-file "$REPO_ROOT/tools/e2e/ci.env" \
  "${DOCKER_ENV_ARGS[@]}" \
  -v "$REPO_ROOT:/workspace" \
  -w /workspace \
  "$IMAGE_TAG" \
  bash -c "pnpm install --frozen-lockfile && pnpm exec nx run ${PROJECT}:e2e"
