#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=nx-native-file-cache.sh
. "$ROOT/tools/nx-native-file-cache.sh"

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-lcars-nx-native-cache.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/repo-a" "$TEST_DIR/repo-b" "$TEST_DIR/cache" "$TEST_DIR/home"
printf 'lockfileVersion: 9\nshared: true\n' >"$TEST_DIR/repo-a/pnpm-lock.yaml"
cp "$TEST_DIR/repo-a/pnpm-lock.yaml" "$TEST_DIR/repo-b/pnpm-lock.yaml"

cache_path() {
  env -u CI -u NX_NATIVE_FILE_CACHE_DIRECTORY -u NX_SKIP_NATIVE_FILE_CACHE \
    HOME="$TEST_DIR/home" XDG_CACHE_HOME="$TEST_DIR/cache" \
    bash -c '. "$1"; configure_agent_lcars_nx_native_file_cache "$2"; printf "%s\n" "$NX_NATIVE_FILE_CACHE_DIRECTORY"' \
    bash "$ROOT/tools/nx-native-file-cache.sh" "$1"
}

first_path="$(cache_path "$TEST_DIR/repo-a")"
same_lock_path="$(cache_path "$TEST_DIR/repo-b")"
[ "$first_path" = "$same_lock_path" ] || {
  echo "same lockfile content did not share one native cache" >&2
  exit 1
}

case "$first_path" in
  "$TEST_DIR/cache/nx-native-file-cache/agent-lcars/"*) ;;
  *)
    echo "cache is not isolated under the Agent LCARS namespace: $first_path" >&2
    exit 1
    ;;
esac

printf 'lockfileVersion: 9\nshared: false\n' >"$TEST_DIR/repo-b/pnpm-lock.yaml"
changed_lock_path="$(cache_path "$TEST_DIR/repo-b")"
[ "$first_path" != "$changed_lock_path" ] || {
  echo "changed lockfile content reused the old native cache" >&2
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

echo "ok: Nx native cache is stable, repository-scoped, and lockfile-fingerprinted"
