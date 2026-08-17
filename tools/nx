#!/bin/bash
# This script executes nx with all forwarded arguments,
# adding required flags for the environment.
set -eo pipefail

# Increase memory limit to prevent OOM errors during large builds/tests
if [[ "$NODE_OPTIONS" != *"--max-old-space-size"* ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=8192"
fi

# Nx 23 copies its native addon to a shared temporary cache before loading it.
# CI jobs do not need that Windows file-lock workaround, and concurrent
# self-hosted jobs have observed SIGSEGVs in the copy/load path. Load the
# immutable addon directly from this job's node_modules instead.
if [ "${CI:-}" = "true" ] && [ -z "${NX_SKIP_NATIVE_FILE_CACHE:-}" ]; then
  export NX_SKIP_NATIVE_FILE_CACHE=true
fi

# Nx 23.1 resolves linked worktrees to the main checkout's cache natively.
# Do not set NX_CACHE_DIRECTORY here: doing so duplicates upstream behavior
# and makes the wrapper responsible for tracking Nx's cache semantics.
#
# That native sharing means `nx reset` can still disrupt other sessions:
# an agent's full reset once wiped a shared cache mid-run and a concurrent
# green build died writing its outputs (agent-lcars#2887, 2026-07-14).
# `--only-cache` removes the shared artifacts, while
# `--only-workspace-data` also removes the main checkout's shared cache DB
# when invoked from a linked worktree. Protect both a linked worktree and a
# primary checkout with registered worktrees. A custom cache/workspace-data
# directory is conservatively treated as shared too.
if [ "${1:-}" = "reset" ] &&
  [ "${NX_ALLOW_SHARED_CACHE_RESET:-}" != "1" ]; then
  nx_state_is_shared=false
  if [ -n "${NX_CACHE_DIRECTORY:-}" ] ||
    [ -n "${NX_WORKSPACE_DATA_DIRECTORY:-}" ] ||
    [ -n "${NX_PROJECT_GRAPH_CACHE_DIRECTORY:-}" ]; then
    nx_state_is_shared=true
  fi

  git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$git_common_dir" ] && [ -n "$toplevel" ]; then
    primary_root="$(dirname "$git_common_dir")"
    if [ "$primary_root" != "$toplevel" ]; then
      nx_state_is_shared=true
    fi

    worktree_count="$(git worktree list --porcelain 2>/dev/null |
      awk '$1 == "worktree" { count++ } END { print count + 0 }' || true)"
    if [ "${worktree_count:-0}" -gt 1 ]; then
      nx_state_is_shared=true
    fi
  fi

  if [ "$nx_state_is_shared" = true ]; then
    reset_has_help=false
    reset_has_safe_scope=false
    reset_has_destructive_scope=false
    for reset_arg in "$@"; do
      case "$reset_arg" in
      --help | -h) reset_has_help=true ;;
      --only-cache | --only-cache=* | --onlyCache | --onlyCache=*)
        reset_has_destructive_scope=true
        ;;
      --only-workspace-data | --only-workspace-data=* | --onlyWorkspaceData | --onlyWorkspaceData=*)
        reset_has_destructive_scope=true
        ;;
      --only-daemon | --only-daemon=* | --onlyDaemon | --onlyDaemon=* | --only-cloud | --only-cloud=* | --onlyCloud | --onlyCloud=*)
        reset_has_safe_scope=true
        ;;
      esac
    done

    if [ "$reset_has_help" = false ] &&
      [ "$reset_has_destructive_scope" = true ]; then
      echo "tools/nx: refusing to reset shared Nx cache/workspace data (sprinkles#3801, agent-lcars#2887)." >&2
      echo "tools/nx: rerun with NX_ALLOW_SHARED_CACHE_RESET=1 only when every checkout using it is idle." >&2
      exit 1
    fi

    if [ "$reset_has_help" = false ] &&
      [ "$reset_has_safe_scope" = false ]; then
      echo "tools/nx: scoping bare 'nx reset' to --only-daemon because Nx state is shared with other worktrees/jobs (sprinkles#3801, agent-lcars#2887)." >&2
      echo "tools/nx: set NX_ALLOW_SHARED_CACHE_RESET=1 only when every checkout using it is idle." >&2
      shift
      set -- reset --only-daemon "$@"
    fi
  fi
fi

# Self-hosted Nx remote cache (the same spark server CI uses). The vars live
# in the gitignored .nx-remote-cache.env — written by the repo's setup script
# (sprinkles' setup-repo.sh, agent-lcars' tools/setup-nx-remote-cache.sh) —
# rather than .env.local, so that ONLY this wrapper enables them, and only
# after a fast reachability probe: nx fails open on an unreachable server but
# pays ~45s of request timeouts per task write (measured), which would tax
# laptops off the VPN. Explicit env (CI sets these directly) wins and skips
# the probe.
#
# Linked worktrees do not inherit ignored files, and a worktree created by a
# bare `git worktree add` never runs setup-worktree.sh — so fall back to the
# primary checkout's copy instead of requiring every worktree to hold its own.
# That keeps ONE credential on disk and makes a rotation in the primary reach
# every worktree immediately, with no stale copy able to win over it.
if [ -z "${NX_SELF_HOSTED_REMOTE_CACHE_SERVER:-}" ]; then
  rc_env=""
  if [ -f .nx-remote-cache.env ]; then
    rc_env=".nx-remote-cache.env"
  else
    rc_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [ -n "$rc_common_dir" ] &&
      [ -f "$(dirname "$rc_common_dir")/.nx-remote-cache.env" ]; then
      rc_env="$(dirname "$rc_common_dir")/.nx-remote-cache.env"
    fi
  fi

  if [ -n "$rc_env" ]; then
    rc_server="$(sed -n 's/^NX_SELF_HOSTED_REMOTE_CACHE_SERVER=//p' "$rc_env" | tail -1)"
    if [ -n "$rc_server" ] &&
      curl -sf --max-time 0.4 -o /dev/null "$rc_server/healthz" 2>/dev/null; then
      set -a
      # shellcheck source=/dev/null
      . "$rc_env"
      set +a
    fi
  elif curl -sf --max-time 0.4 -o /dev/null \
    "${NX_REMOTE_CACHE_URL:-http://spark.lan.jlapenna.net:3123}/healthz" 2>/dev/null; then
    # No credential anywhere, but the cache server is right there answering.
    # Say so once per invocation: the setup script is one-time init, so a
    # checkout created before its cache block existed (sprinkles#2442,
    # 2026-07-10) never got a credential and nothing would ever tell you --
    # Nx just recomputes everything locally and the build is merely "slow".
    # That cost a 35-minute Verify timeout on sprinkles#4262 before anyone
    # noticed.
    setup_hint="./tools/setup-repo.sh"
    if [ -x ./tools/setup-nx-remote-cache.sh ]; then
      setup_hint="./tools/setup-nx-remote-cache.sh"
    fi
    echo "⚠️  Nx remote cache is reachable but no credential is configured;" >&2
    echo "   builds will recompute locally. Fix: $setup_hint" >&2
  fi
fi

# Node's own compile cache (nx/dist/src/utils/compile-cache.js) is enabled as
# nx's first import, before nx loads .env/.env.local - too early for a
# dotenv-set TMPDIR to reach it. Read TMPDIR straight out of .env.local here,
# at the shell level, so a personal disk-backed override actually applies to
# this one cache. No-op if .env.local doesn't set TMPDIR (Node keeps its
# default, tmpfs-based location).
if [ -z "${NODE_COMPILE_CACHE:-}" ] && [ -f .env.local ]; then
  local_tmpdir="$(sed -n 's/^TMPDIR=//p' .env.local | tail -1)"
  [ -n "$local_tmpdir" ] && export NODE_COMPILE_CACHE="$local_tmpdir/node-compile-cache"
fi

# Otherwise default the compile cache on: every Nx invocation re-parses
# megabytes of JS at startup, and Node's on-disk compile cache shaves a
# consistent chunk off that for free. Shared across worktrees (keyed by file
# content), so agent sessions benefit from each other's warm cache.
if [ -z "${NODE_COMPILE_CACHE:-}" ]; then
  export NODE_COMPILE_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/node-compile-cache"
fi

# Use pnpm exec to ensure we use the workspace-local nx version.
if command -v pnpm >/dev/null 2>&1; then
  exec pnpm exec nx --outputStyle=stream "$@"
elif [ -f "./node_modules/.bin/nx" ]; then
  exec ./node_modules/.bin/nx --outputStyle=stream "$@"
else
  echo "CRITICAL: pnpm or nx NOT FOUND"
  exit 1
fi
