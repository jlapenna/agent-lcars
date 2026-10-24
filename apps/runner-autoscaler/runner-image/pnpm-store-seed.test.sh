#!/usr/bin/env bash
# The full proof is a mandatory dependency of the published runner image.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
bash "$here/pnpm-store-seed-inputs.test.sh"
command -v docker >/dev/null 2>&1 || {
  echo 'docker/buildx is required to execute the complete image-build proof' >&2
  exit 1
}
docker buildx build --file "$here/Dockerfile" --target pnpm-store-proof \
  --output type=cacheonly "$here"
echo 'pnpm-store-seed.test.sh: production fetch, CPU selection, lower-layer hit/miss and separate-filesystem proof passed'
