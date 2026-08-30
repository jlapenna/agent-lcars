#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$here/../../.." && pwd -P)"
dockerfile="$here/Dockerfile"
regression_dockerfile="$here/pnpm-seed-regression.Dockerfile"
seed_dir="$here/pnpm-seed"
fixture_dir="$here/pnpm-seed-regression"

require_equal_package_manager() {
  local manifest="$1"
  local expected="$2"
  local actual
  actual="$(node -p "require(process.argv[1]).packageManager" "$manifest")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$manifest must use packageManager $expected (got $actual)" >&2
    exit 1
  fi
}

root_package_manager="$(node -p "require(process.argv[1]).packageManager" "$repo_root/package.json")"
require_equal_package_manager "$seed_dir/package.json" "$root_package_manager"
require_equal_package_manager "$seed_dir/pnpm10/package.json" 'pnpm@10.34.5'
for fixture in seed hit miss; do
  require_equal_package_manager "$fixture_dir/$fixture/package.json" "$root_package_manager"
done
for fixture in seed-pnpm10 hit-pnpm10 miss-pnpm10; do
  require_equal_package_manager "$fixture_dir/$fixture/package.json" 'pnpm@10.34.5'
done

# The production build uses the runner user's normal pnpm store.
grep -Fqx 'COPY pnpm-seed/package.json pnpm-seed/pnpm-lock.yaml ./' "$dockerfile"
grep -Fqx 'RUN pnpm fetch --frozen-lockfile --ignore-scripts --store-dir /pnpm-store' "$dockerfile"
grep -Fqx '    /pnpm-store/ /home/runner/.local/share/pnpm/store/' "$dockerfile"
if ! grep -Fq 'COPY --from=pnpm-store-seed --chown=runner:runner \' "$dockerfile"; then
  echo 'runner image must copy the isolated pnpm store seed into the final image' >&2
  exit 1
fi
grep -Fqx 'COPY pnpm-seed/pnpm10/package.json pnpm-seed/pnpm10/pnpm-lock.yaml ./' "$dockerfile"
if ! grep -Fq 'COPY --from=pnpm10-store-seed --chown=runner:runner \' "$dockerfile"; then
  echo 'runner image must copy the pnpm 10 compatibility store into the final image' >&2
  exit 1
fi
if rg -q '^FROM --platform=.* AS pnpm(10-)?store-seed$' "$dockerfile"; then
  echo 'pnpm seeds must build for the target image architecture, not a fixed builder platform' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'docker is required to prove pnpm store lower-layer behavior' >&2
  exit 1
fi

tag="agent-lcars-pnpm-store-seed-test-$$"
container_id=""
cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  docker image rm -f "$tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# This compact image has the same relevant layer shape as the production
# Dockerfile but keeps the regression fast: TypeScript is an intentionally
# large seeded hit; is-number is intentionally absent and must become a
# writable miss. pnpm 11 keeps supply-chain-policy metadata outside the
# content-addressable store, so the hit checks its own transfer accounting:
# package content must be `reused` and never `downloaded`.
docker build --file "$regression_dockerfile" --tag "$tag" "$here"

seed_bytes="$(docker run --rm --entrypoint bash "$tag" -c 'du -sb /home/runner/.local/share/pnpm/store | cut -f1')"
if [[ ! "$seed_bytes" =~ ^[0-9]+$ ]] || (( seed_bytes < 1048576 )); then
  echo "regression seed is unexpectedly small: $seed_bytes bytes" >&2
  exit 1
fi

container_id="$(docker create "$tag" bash -ceu '
  cd /opt/pnpm-hit-pnpm10
  pnpm --config.minimum-release-age=0 install --frozen-lockfile --ignore-scripts | tee /tmp/pnpm10-hit.log
  grep -Eq "reused 1, downloaded 0" /tmp/pnpm10-hit.log
  test -f node_modules/typescript/lib/typescript.js
  rm -rf node_modules

  cd /opt/pnpm-miss-pnpm10
  pnpm --config.minimum-release-age=0 install --frozen-lockfile --ignore-scripts
  test -f node_modules/is-number/index.js
  rm -rf node_modules

  cd /opt/pnpm-hit
  pnpm --config.minimum-release-age=0 install --frozen-lockfile --ignore-scripts | tee /tmp/pnpm-hit.log
  grep -Eq "reused 1, downloaded 0" /tmp/pnpm-hit.log
  test -f node_modules/typescript/lib/typescript.js
  rm -rf node_modules

  cd /opt/pnpm-miss
  pnpm install --frozen-lockfile --ignore-scripts
  test -f node_modules/is-number/index.js
  rm -rf node_modules
')"
docker start --attach "$container_id"

# Docker's portable changed-path API works for both the legacy overlay2 driver
# and Docker's containerd-backed overlayfs driver (which intentionally omits
# GraphDriver.UpperDir from `docker inspect`). A one-package miss may add a few
# content files, but it must not add the many files that make up the seed.
for store_major in 10 11; do
  seed_file_count="$(docker run --rm --entrypoint bash "$tag" -c "find /home/runner/.local/share/pnpm/store/v${store_major}/files -type f | wc -l")"
  added_store_file_count="$(docker diff "$container_id" | awk -v path="^/home/runner/.local/share/pnpm/store/v${store_major}/files/" '$1 == "A" && $2 ~ path { count += 1 } END { print count + 0 }')"
  if [[ ! "$seed_file_count" =~ ^[0-9]+$ ]] || (( seed_file_count < 10 )); then
    echo "pnpm $store_major regression seed has too few content files: $seed_file_count" >&2
    exit 1
  fi
  if (( added_store_file_count == 0 )); then
    echo "pnpm $store_major writable miss did not add package content to the runner store" >&2
    exit 1
  fi
  if (( added_store_file_count * 4 >= seed_file_count )); then
    echo "pnpm $store_major writable miss copied too much of the seed: added=$added_store_file_count seed=$seed_file_count" >&2
    exit 1
  fi
done

echo "pnpm-store-seed.test.sh: pnpm 10/11 lower-layer content hits and writable misses passed (seed=${seed_bytes}B)"
