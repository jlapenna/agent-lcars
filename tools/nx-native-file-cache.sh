#!/usr/bin/env bash

# Configure Nx's extracted native binding cache before Node starts. Nx's
# default includes the workspace root in its cache key, so every linked
# worktree otherwise stores another identical ~22 MiB binding under /tmp.
configure_agent_lcars_nx_native_file_cache() {
  local repo_root="$1"
  local lockfile="$repo_root/pnpm-lock.yaml"
  local lock_fingerprint
  local cache_home

  # An explicit caller choice wins. CI deliberately skips this cache in the
  # shared repo-nx launcher because concurrent copy/load previously caused
  # SIGSEGVs on self-hosted runners.
  if [ -n "${NX_NATIVE_FILE_CACHE_DIRECTORY:-}" ] ||
    [ "${NX_SKIP_NATIVE_FILE_CACHE:-}" = "true" ] ||
    [ "${CI:-}" = "true" ]; then
    return 0
  fi

  if [ ! -f "$lockfile" ]; then
    echo "tools/nx: cannot fingerprint Nx dependencies: $lockfile is missing" >&2
    return 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    lock_fingerprint="$(sha256sum -- "$lockfile" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    lock_fingerprint="$(shasum -a 256 -- "$lockfile" | awk '{ print $1 }')"
  else
    echo "tools/nx: sha256sum or shasum is required to fingerprint $lockfile" >&2
    return 1
  fi

  if [ -n "${XDG_CACHE_HOME:-}" ]; then
    cache_home="$XDG_CACHE_HOME"
  elif [ -n "${HOME:-}" ]; then
    cache_home="$HOME/.cache"
  else
    echo "tools/nx: HOME or XDG_CACHE_HOME is required for the native cache" >&2
    return 1
  fi

  export NX_NATIVE_FILE_CACHE_DIRECTORY="$cache_home/nx-native-file-cache/agent-lcars/$lock_fingerprint"
}
