#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
dockerfile="$here/Dockerfile"
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

seed_package_manager="$(node -p "require(process.argv[1]).packageManager" "$fixture_dir/seed/package.json")"
if [[ "$seed_package_manager" != pnpm@11.* ]]; then
  echo "regression seed must use pnpm 11 (got $seed_package_manager)" >&2
  exit 1
fi
# Every fleet seed directory is a fetchable pnpm 11 lockfile snapshot, and
# the fleet list and its synced directories agree (tools/sync-runner-pnpm-seed.py).
expected_dirs="$(node -p "require(process.argv[1]).repositories.map((r) => r.replace('/', '__')).sort().join('\\n')" "$seed_dir/fleet.json")"
actual_dirs="$(find "$seed_dir/fleet" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)"
if [[ "$expected_dirs" != "$actual_dirs" ]]; then
  echo "pnpm-seed/fleet does not match fleet.json (run tools/sync-runner-pnpm-seed.py)" >&2
  exit 1
fi
while IFS= read -r repository_dir; do
  lockfile="$seed_dir/fleet/$repository_dir/pnpm-lock.yaml"
  # #2084 emptied every seed lockfile; #2151 left stale patch hashes. Both
  # passed CI and failed only at publication. tools/sync-runner-pnpm-seed.py
  # refuses these too; this keeps a hand edit or a bot rewrite honest.
  if ! grep -Eq "^lockfileVersion: '9\.[0-9]+'$" "$lockfile" ||
    ! awk '/^packages:$/ { in_packages = 1; next } in_packages && NF { found = /^  [^ ]/; exit } END { exit !found }' "$lockfile"; then
    echo "$repository_dir seeds an empty or non-pnpm-11 lockfile (run tools/sync-runner-pnpm-seed.py)" >&2
    exit 1
  fi
  if grep -Eq '^patchedDependencies:|\(patch_hash=' "$lockfile"; then
    echo "$repository_dir seed lockfile still references patches (run tools/sync-runner-pnpm-seed.py)" >&2
    exit 1
  fi
  if grep -Fq 'npm.pkg.github.com/' "$lockfile"; then
    echo "$repository_dir seeds authenticated GitHub Packages content (run tools/sync-runner-pnpm-seed.py)" >&2
    exit 1
  fi
  package_manager="$(node -p "require(process.argv[1]).packageManager" "$seed_dir/fleet/$repository_dir/package.json")"
  if [[ "$package_manager" != pnpm@11.* ]]; then
    echo "$repository_dir seeds $package_manager; the image seeds the pnpm 11 (v11) store" >&2
    exit 1
  fi
done <<<"$actual_dirs"
# The regression image resolves pnpm from its curated seed, independently of
# consumer dependency updates. Its hit and miss must use that same version.
for fixture in hit miss; do
  require_equal_package_manager "$fixture_dir/$fixture/package.json" "$seed_package_manager"
done

# pnpm clones a `type: git` resolution with the git CLI, which node:*-slim
# lacks: Sprinkles' git+https fleet-runtime/repo-tools locks failed every
# publication with ERR_PNPM_GIT_FETCHER_GIT_NOT_FOUND after #2136.
seed_stage="$(awk '/ AS pnpm-store-seed$/ { in_stage = 1 } in_stage && /^FROM / && !/ AS pnpm-store-seed$/ { exit } in_stage' "$dockerfile")"
if grep -Eq 'type: git([},]|$)' "$seed_dir"/fleet/*/pnpm-lock.yaml &&
  ! grep -Eq 'apt-get install .*\bgit\b' <<<"$seed_stage"; then
  echo 'a fleet seed locks a git-hosted package; the pnpm-store-seed stage must install git' >&2
  exit 1
fi

# The production build uses the runner user's normal pnpm store.
grep -Fqx 'COPY pnpm-seed/fleet/ ./' "$dockerfile"
# pnpm's registry-metadata cache ships with the store (#2082), minus the seed's
# own lockfile-verification record.
grep -Fqx '    rm -f /pnpm-cache/lockfile-verified.jsonl' "$dockerfile"
# pnpm >= 11.28.5 reads its registry-metadata mirror from v12/metadata, not
# v11/metadata (pnpm/pnpm#13512, #2902). The seed stage must require the mirror
# of every fleet pin and never ship a seed that lacks the current one.
grep -Fqx "    done < /fleet-pnpm-pins; \\" "$dockerfile"
grep -Fqx '    test -d /pnpm-cache/v12/metadata' "$dockerfile"
if grep -Fqx '    test -d /pnpm-cache/v11/metadata' "$dockerfile"; then
  echo 'the seed stage must not require v11/metadata: pnpm >= 11.28.5 writes v12/metadata (#2902)' >&2
  exit 1
fi
grep -Fqx '    /pnpm-cache/ /home/runner/.cache/pnpm/' "$dockerfile"
grep -Fqx 'COPY --from=pnpm-store-seed /pnpm-cache/ /pnpm-cache/' "$dockerfile"
grep -Fqx '    /pnpm-store/ /home/runner/.local/share/pnpm/store/' "$dockerfile"
# Match the store COPY itself: the Corepack-cache COPY uses the same prefix.
if ! grep -Fx -A1 "COPY --from=pnpm-store-seed --chown=runner:runner \\" "$dockerfile" |
  grep -Fqx '    /pnpm-store/ /home/runner/.local/share/pnpm/store/'; then
  echo 'runner image must copy the isolated pnpm store seed into the final image' >&2
  exit 1
fi
echo "pnpm-store-seed-inputs.test.sh: pnpm 11 seed input contracts passed; full proof gates image builds"
