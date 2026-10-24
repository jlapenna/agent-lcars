#!/usr/bin/env bash
# Execute against a pristine image-seeded store as the actual runner UID.
set -euo pipefail
export LC_ALL=C
fail() { echo "pnpm seed proof: $*" >&2; exit 1; }
[[ "$(id -u)" == 1001 ]] || fail "expected runner UID 1001"
store=/home/runner/.local/share/pnpm/store
proof=/home/runner/.cache/pnpm-proof
mkdir -p "$proof"
case "${1:-}" in
  layer)
    seed_bytes="$(du -sb "$store" | cut -f1)"
    if [[ ! "$seed_bytes" =~ ^[0-9]+$ ]] || (( seed_bytes < 1048576 )); then
      fail "regression seed is unexpectedly small: $seed_bytes bytes"
    fi
    # Docker diff's old A numerator included directories and symlinks too.
    # Count all newly added descendant paths, while retaining its regular-file
    # seed denominator. This measures additions, not physical copy-up.
    find "$store/v11/files" -mindepth 1 -printf '%P\n' | sort > "$proof/before"
    seed_file_count="$(find "$store/v11/files" -type f | wc -l)"
    if [[ ! "$seed_file_count" =~ ^[0-9]+$ ]] || (( seed_file_count < 10 )); then
      fail "pnpm 11 regression seed has too few content files: $seed_file_count"
    fi

    cd /opt/pnpm-hit
    pnpm --config.minimum-release-age=0 install --frozen-lockfile --ignore-scripts | tee /tmp/pnpm-hit.log
    grep -Eq 'reused 1, downloaded 0' /tmp/pnpm-hit.log
    test -f node_modules/typescript/lib/typescript.js
    rm -rf node_modules

    cd /opt/pnpm-miss
    pnpm install --frozen-lockfile --ignore-scripts
    test -f node_modules/is-number/index.js
    rm -rf node_modules

    find "$store/v11/files" -mindepth 1 -printf '%P\n' | sort > "$proof/after"
    added_store_file_count="$(comm -13 "$proof/before" "$proof/after" | wc -l)"
    [[ "$added_store_file_count" =~ ^[0-9]+$ ]] || fail "invalid added-path count"
    (( added_store_file_count > 0 )) || fail "pnpm 11 writable miss did not add package content"
    (( added_store_file_count * 4 < seed_file_count )) || fail "pnpm 11 writable miss added too many paths: added=$added_store_file_count seed=$seed_file_count"
    printf 'passed\n' > "$proof/layer.ok"
    echo "pnpm store lower-layer content hit and writable miss passed (seed=${seed_bytes}B, added=${added_store_file_count})"
    ;;
  work-mount)
    # The project really must be on a different filesystem from the image seed.
    [[ "$(stat -c %d /home/runner/_work)" != "$(stat -c %d "$store")" ]] || fail "work mount must be a separate filesystem"
    mkdir -p /home/runner/_work/hit
    cp -r /opt/pnpm-hit/* /home/runner/_work/hit/
    cd /home/runner/_work/hit
    pnpm install --frozen-lockfile --ignore-scripts | tee /tmp/pnpm-work-hit.log
    grep -Eq 'reused 1, downloaded 0' /tmp/pnpm-work-hit.log
    grep -Fq 'Content-addressable store is at: /home/runner/.local/share/pnpm/store/v11' /tmp/pnpm-work-hit.log
    test -f node_modules/typescript/lib/typescript.js
    printf 'passed\n' > "$proof/work-mount.ok"
    ;;
  *) echo 'expected layer or work-mount proof' >&2; exit 2 ;;
esac
