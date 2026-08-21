#!/usr/bin/env bash

# Configure Nx's extracted native binding cache before Node starts. Nx's
# default includes the workspace root in its cache key, so every linked
# worktree otherwise stores another identical ~22 MiB binding under /tmp.
configure_agent_lcars_nx_native_file_cache() {
  local repo_root="$1"
  local cache_home
  local nx_version
  local native_source=""
  local candidate
  local native_fingerprint
  local cache_dir
  local target
  local staging

  # An explicit caller choice wins. CI deliberately skips this cache in the
  # shared repo-nx launcher because concurrent copy/load previously caused
  # SIGSEGVs on self-hosted runners.
  if [ -n "${NX_NATIVE_FILE_CACHE_DIRECTORY:-}" ] ||
    [ "${NX_SKIP_NATIVE_FILE_CACHE:-}" = "true" ] ||
    [ "${CI:-}" = "true" ]; then
    return 0
  fi

  if [ ! -f "$repo_root/node_modules/nx/package.json" ]; then
    # Some contract tests deliberately exercise wrappers before dependencies
    # are installed. Leave the variable unset; the downstream package-manager
    # command will provide its normal missing-install error.
    return 0
  fi

  nx_version="$(
    sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' \
      "$repo_root/node_modules/nx/package.json" | head -1
  )"
  if [ -z "$nx_version" ]; then
    echo "tools/nx: cannot read the installed Nx version" >&2
    return 1
  fi

  # pnpm installs only the native package for the current platform. Match it
  # to the active Nx version so an unrelated copy in the virtual store cannot
  # determine this process's cache identity.
  for candidate in \
    "$repo_root"/node_modules/.pnpm/@nx+nx-*@"$nx_version"/node_modules/@nx/nx-*/*.node; do
    [ -f "$candidate" ] || continue
    if [ -n "$native_source" ]; then
      echo "tools/nx: multiple native bindings found for Nx $nx_version" >&2
      return 1
    fi
    native_source="$candidate"
  done
  if [ -z "$native_source" ]; then
    echo "tools/nx: cannot find the native binding for Nx $nx_version" >&2
    return 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    native_fingerprint="$(sha256sum -- "$native_source" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    native_fingerprint="$(shasum -a 256 -- "$native_source" | awk '{ print $1 }')"
  else
    echo "tools/nx: sha256sum or shasum is required to fingerprint the Nx native binding" >&2
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

  cache_dir="$cache_home/nx-native-file-cache/agent-lcars/$native_fingerprint"
  target="$cache_dir/$nx_version-$(basename "$native_source")"
  export NX_NATIVE_FILE_CACHE_DIRECTORY="$cache_dir"

  mkdir -p "$cache_dir"
  if [ -e "$target" ]; then
    if cmp -s "$native_source" "$target"; then
      return 0
    fi
    echo "tools/nx: cached native binding failed content validation: $target" >&2
    return 1
  fi

  # Publish the complete binding without ever exposing a partial target. A
  # direct hard link is atomic and consumes no extra data blocks when the
  # repository and cache share a filesystem. Otherwise copy to a private file
  # in the cache directory and atomically hard-link that completed inode into
  # place. Concurrent publishers either win the link or validate the identical
  # winner; nobody overwrites a file another process may already be loading.
  if ln "$native_source" "$target" 2>/dev/null; then
    return 0
  fi
  if [ -e "$target" ]; then
    if cmp -s "$native_source" "$target"; then
      return 0
    fi
    echo "tools/nx: concurrently published native binding failed validation: $target" >&2
    return 1
  fi

  staging="$cache_dir/.$nx_version-$(basename "$native_source").$$.$RANDOM"
  if ! cp "$native_source" "$staging"; then
    rm -f -- "$staging"
    echo "tools/nx: failed to stage the native binding in $cache_dir" >&2
    return 1
  fi
  if ln "$staging" "$target" 2>/dev/null; then
    rm -f -- "$staging"
    return 0
  fi
  rm -f -- "$staging"
  if [ -e "$target" ] && cmp -s "$native_source" "$target"; then
    return 0
  fi

  echo "tools/nx: failed to publish the native binding atomically: $target" >&2
  return 1
}
