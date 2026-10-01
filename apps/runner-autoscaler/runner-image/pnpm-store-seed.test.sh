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
# Every fleet seed directory is a fetchable pnpm 11 lockfile snapshot, and
# the fleet list and its synced directories agree (tools/sync-runner-pnpm-seed.py).
expected_dirs="$(node -p "require(process.argv[1]).repositories.map((r) => r.replace('/', '__')).sort().join('\\n')" "$seed_dir/fleet.json")"
actual_dirs="$(find "$seed_dir/fleet" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)"
if [[ "$expected_dirs" != "$actual_dirs" ]]; then
  echo "pnpm-seed/fleet does not match fleet.json (run tools/sync-runner-pnpm-seed.py)" >&2
  exit 1
fi
while IFS= read -r repository_dir; do
  test -s "$seed_dir/fleet/$repository_dir/pnpm-lock.yaml"
  package_manager="$(node -p "require(process.argv[1]).packageManager" "$seed_dir/fleet/$repository_dir/package.json")"
  if [[ "$package_manager" != pnpm@11.* ]]; then
    echo "$repository_dir seeds $package_manager; the image seeds the pnpm 11 (v11) store" >&2
    exit 1
  fi
done <<<"$actual_dirs"
for fixture in seed hit miss; do
  require_equal_package_manager "$fixture_dir/$fixture/package.json" "$root_package_manager"
done

# The production build uses the runner user's normal pnpm store.
grep -Fqx 'COPY pnpm-seed/fleet/ ./' "$dockerfile"
grep -Fqx '          --config.minimum-release-age=0 --store-dir /pnpm-store \' "$dockerfile"
# pnpm's registry-metadata cache ships with the store (#2082), minus the seed's
# own lockfile-verification record.
grep -Fqx '          --config.cache-dir=/pnpm-cache); \' "$dockerfile"
grep -Fqx '    rm -f /pnpm-cache/lockfile-verified.jsonl; \' "$dockerfile"
grep -Fqx '    /pnpm-cache/ /home/runner/.cache/pnpm/' "$dockerfile"
grep -Fqx 'COPY --from=pnpm-store-seed /pnpm-cache/ /pnpm-cache/' "$dockerfile"
grep -Fqx '    /pnpm-store/ /home/runner/.local/share/pnpm/store/' "$dockerfile"
if ! grep -Fq 'COPY --from=pnpm-store-seed --chown=runner:runner \' "$dockerfile"; then
  echo 'runner image must copy the isolated pnpm store seed into the final image' >&2
  exit 1
fi
if grep -Eq '^FROM --platform=.* AS pnpm-store-seed$' "$dockerfile"; then
  echo 'pnpm seeds must build for the target image architecture, not a fixed builder platform' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'docker is required to prove pnpm store lower-layer behavior' >&2
  exit 1
fi

tag="agent-lcars-pnpm-store-seed-test-$$"
container_id=""
work_mount_container_id=""
cleanup() {
  for cid in "$container_id" "$work_mount_container_id"; do
    if [[ -n "$cid" ]]; then
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  done
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
for store_major in 11; do
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

# k3s runner pods (homelab#1623) mount /home/runner/_work on its own
# filesystem (hostPath before, emptyDir now), separate from the image
# filesystem the seed lives on. pnpm's *default* store-dir is chosen on the
# SAME filesystem as the project being installed (so it can hardlink), so a
# project under _work must still resolve to the pinned seed instead of
# pnpm silently creating and populating a fresh, empty store under _work
# and re-downloading every package -- exactly the live regression measured
# on lcars-ci-dbttw-runner-m4qsc ("Content-addressable store is at:
# /home/runner/_work/.pnpm-store/v11", "reused 0, downloaded 1743"). This
# case must fail without the Dockerfile's pnpm global-config pin and pass
# with it.
work_mount_container_id="$(docker create --tmpfs /home/runner/_work:rw,uid=1001,gid=1001 "$tag" bash -ceu '
  mkdir -p /home/runner/_work/hit
  cp -r /opt/pnpm-hit/* /home/runner/_work/hit/
  cd /home/runner/_work/hit
  pnpm install --frozen-lockfile --ignore-scripts | tee /tmp/pnpm-work-hit.log
  grep -Eq "reused 1, downloaded 0" /tmp/pnpm-work-hit.log
  grep -Fq "Content-addressable store is at: /home/runner/.local/share/pnpm/store/v11" /tmp/pnpm-work-hit.log
  test -f node_modules/typescript/lib/typescript.js
')"
docker start --attach "$work_mount_container_id"

echo "pnpm-store-seed.test.sh: pnpm 11 lower-layer content hit and writable miss passed (seed=${seed_bytes}B)"
