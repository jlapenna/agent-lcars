#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=nx-native-file-cache.sh
. "$ROOT/tools/nx-native-file-cache.sh"

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-lcars-nx-native-cache.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

make_fake_repo() {
  local repo="$1"
  local binding_content="$2"
  local package_dir="$repo/node_modules/.pnpm/@nx+nx-linux-x64-gnu@23.1.1/node_modules/@nx/nx-linux-x64-gnu"

  mkdir -p "$repo/node_modules/nx" "$package_dir"
  printf '{\n  "name": "nx",\n  "version": "23.1.1",\n  "private": false\n}\n' \
    >"$repo/node_modules/nx/package.json"
  printf '%s\n' "$binding_content" >"$package_dir/nx.linux-x64-gnu.node"
  printf 'lockfileVersion: 9\n' >"$repo/pnpm-lock.yaml"
}

make_fake_repo "$TEST_DIR/repo-a" 'native artifact A'
make_fake_repo "$TEST_DIR/repo-b" 'native artifact A'
make_fake_repo "$TEST_DIR/repo-c" 'native artifact B'
mkdir -p "$TEST_DIR/cache" "$TEST_DIR/home"

cache_path() {
  env -u CI -u NX_NATIVE_FILE_CACHE_DIRECTORY -u NX_SKIP_NATIVE_FILE_CACHE \
    HOME="$TEST_DIR/home" XDG_CACHE_HOME="$TEST_DIR/cache" \
    bash -c '. "$1"; configure_agent_lcars_nx_native_file_cache "$2"; printf "%s\n" "$NX_NATIVE_FILE_CACHE_DIRECTORY"' \
    bash "$ROOT/tools/nx-native-file-cache.sh" "$1"
}

# Exercise concurrent first use before any process has populated the target.
for worker in 1 2 3 4 5 6 7 8; do
  cache_path "$TEST_DIR/repo-a" >"$TEST_DIR/worker-$worker" &
done
wait

first_path="$(cat "$TEST_DIR/worker-1")"
for worker in 2 3 4 5 6 7 8; do
  [ "$(cat "$TEST_DIR/worker-$worker")" = "$first_path" ] || {
    echo "concurrent first use resolved different native caches" >&2
    exit 1
  }
done

same_binary_path="$(cache_path "$TEST_DIR/repo-b")"
[ "$first_path" = "$same_binary_path" ] || {
  echo "identical native artifacts did not share one cache" >&2
  exit 1
}

# An unrelated lockfile edit must not allocate another 22 MiB namespace.
printf 'lockfileVersion: 9\nunrelatedChange: true\n' >"$TEST_DIR/repo-b/pnpm-lock.yaml"
[ "$(cache_path "$TEST_DIR/repo-b")" = "$first_path" ] || {
  echo "unrelated lockfile content changed the native cache" >&2
  exit 1
}

changed_binary_path="$(cache_path "$TEST_DIR/repo-c")"
[ "$first_path" != "$changed_binary_path" ] || {
  echo "different native artifacts shared one cache" >&2
  exit 1
}

case "$first_path" in
  "$TEST_DIR/cache/nx-native-file-cache/agent-lcars/"*) ;;
  *)
    echo "cache is not isolated under the Agent LCARS namespace: $first_path" >&2
    exit 1
    ;;
esac

source_binding="$TEST_DIR/repo-a/node_modules/.pnpm/@nx+nx-linux-x64-gnu@23.1.1/node_modules/@nx/nx-linux-x64-gnu/nx.linux-x64-gnu.node"
cached_binding="$first_path/23.1.1-nx.linux-x64-gnu.node"
cmp -s "$source_binding" "$cached_binding" || {
  echo "atomically published binding does not match its source" >&2
  exit 1
}
[ "$(find "$first_path" -maxdepth 1 -type f | wc -l)" -eq 1 ] || {
  echo "concurrent first use left staging files behind" >&2
  exit 1
}

override="$TEST_DIR/explicit-cache"
actual_override="$({
  NX_NATIVE_FILE_CACHE_DIRECTORY="$override"
  configure_agent_lcars_nx_native_file_cache "$TEST_DIR/repo-a"
  printf '%s\n' "$NX_NATIVE_FILE_CACHE_DIRECTORY"
})"
[ "$actual_override" = "$override" ] || {
  echo "explicit NX_NATIVE_FILE_CACHE_DIRECTORY was overwritten" >&2
  exit 1
}

ci_path="$({
  export CI=true
  unset NX_NATIVE_FILE_CACHE_DIRECTORY
  configure_agent_lcars_nx_native_file_cache "$TEST_DIR/repo-a"
  printf '%s\n' "${NX_NATIVE_FILE_CACHE_DIRECTORY:-}"
})"
[ -z "$ci_path" ] || {
  echo "CI native-cache safety behavior was replaced" >&2
  exit 1
}

echo "ok: Nx native cache is content-addressed and atomically shared"
