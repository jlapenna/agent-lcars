#!/usr/bin/env bash
#
# Runs an e2e project's Playwright suite inside the same pinned Docker
# environment that backs the trusted CI runner. This is the local path for
# reproducing browser/runtime-specific failures without making rendered pixels
# themselves a pass/fail contract.
#
# WARNING: this replaces the host checkout's node_modules/ with an empty
# directory (see the Turbopack note below) so the container can mount its own
# in its place. Run `pnpm install` again afterward before using this checkout
# for anything on the host directly.
#
# Ported from members' tools/e2e-docker.sh (this repo's origin, #2373 Phase
# 2's hardening), trimmed to agent-lcars' single e2e project. #908 reconciled
# the two remaining differences that mattered: this now PULLS the same
# content-hash-tagged image canonical homelab publication creates
# (agent-lcars/e2e, keyed off tools/e2e/Dockerfile's own sha256) instead of
# building on demand, and it skips `pnpm install` entirely
# once install.stamp already matches the lockfile/package.json/patches/image
# tuple -- ported from sprinkles' v4 design (#4049), but deliberately NOT its
# run.lock/suite.lock/MemTotal-sized concurrency-slot machinery: that exists
# there to schedule SEVEN suites against finite host memory, and this repo
# has one. What one suite genuinely needs -- and lacked before #908 -- is
# mutual exclusion, full stop: a single exclusive flock for the whole
# invocation (install-if-needed, then the suite itself), the same shape
# tools/e2e-local.sh already uses for its own host-direct run. This finally
# fixes the race this file used to just document as a caveat: two
# e2e-docker.sh runs from different worktrees writing into the same shared
# node_modules mount at once. The Docker-in-Docker path translation, resource
# caps, and forwardAllArgs safety check below are kept as-is: they fix real,
# previously-hit failures, not stylistic choices.
#
# Usage:
#   tools/e2e-docker.sh <nx-project> [-- <playwright args>]
#   E2E_GREP="pattern" tools/e2e-docker.sh <nx-project>
#   -- <playwright args> forwarded verbatim to the underlying implementation
#                        target -- only takes effect if that target does NOT
#                        set `forwardAllArgs: false`. This repo's console-e2e
#                        implementation DOES set it (its `command` is a single
#                        shell string wrapping `firebase emulators:exec
#                        "..."`, and forwardAllArgs:true would append CLI
#                        args to the end of that outer string, landing them
#                        outside the inner quoted subcommand instead of
#                        reaching Playwright -- actively wrong, not merely a
#                        no-op). This script checks `forwardAllArgs` via
#                        `nx show project --json` before running and REFUSES
#                        to run rather than silently dropping the args.
#   E2E_GREP="pattern"  env-var equivalent for projects where the CLI
#                       passthrough above is rejected: forwarded into the
#                       container and read by playwright.config.ts to scope a
#                       run to one spec/suite.
#
# Resource caps (override for bigger/smaller machines):
#   E2E_DOCKER_MEMORY=12g  E2E_DOCKER_MEMORY_SWAP=14g  E2E_DOCKER_PIDS=8192
#   NX_MAX_PARALLEL=2      NODE_OPTIONS=--max-old-space-size=8192
#
# App config comes only from tools/e2e/ci.env. The implementation target reads
# that file directly and points its optional local override at the container's
# isolated HOME, where it does not exist. Host .env files are never loaded.
#
# NEXT_PUBLIC_FIREBASE_*/AUTH_SECRET are the one exception: they're passed as
# real `docker run -e` flags below (sourced from ci.env via ci_env_value, not
# hardcoded) rather than left for dotenv to load later. Next.js inlines
# NEXT_PUBLIC_* at `next build` time -- which runs as part of `nx run
# <project>:e2e-implementation`'s dependsOn chain, BEFORE the dotenv-wrapped
# `firebase emulators:exec "..."` command that actually loads ci.env ever
# starts -- and Auth.js reads AUTH_SECRET just as early, during the
# production server's own initialization. Left to only .env.e2e, both would
# silently bake in as empty/undefined.
#
# Because the host glibc differs from the container's, the container gets its
# own node_modules (shared across worktrees under
# ~/.cache/agent-lcars-e2e-docker; override with E2E_DOCKER_CACHE_DIR) so
# host-built native binaries are never reused inside the container and vice
# versa -- without paying a cold install per worktree. The install.stamp
# cache and run.lock below live in that same shared directory, so the lock
# correctly serializes every worktree of this checkout against the ONE
# node_modules mount they all share -- not just concurrent runs within a
# single worktree.
#
# E2E_DOCKER_DRY_RUN=1 prints the derived image tag, the install.stamp
# hit/miss decision, and the exact `docker run` argv instead of doing
# anything -- no docker, pull, or lock involved, so
# tools/e2e-docker-isolation.test.sh can exercise this wrapper's stamp/tag
# logic without Docker.
set -euo pipefail

PROJECT="${1:?usage: tools/e2e-docker.sh <nx-project> [-- <playwright args>]}"
shift || true

PASSTHROUGH_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      PASSTHROUGH_ARGS=("$@")
      break
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

DRY_RUN=0
if [ "${E2E_DOCKER_DRY_RUN:-}" = "1" ]; then
  DRY_RUN=1
fi

ROOT="$(git rev-parse --show-toplevel)"

# Reads one KEY="value" line out of tools/e2e/ci.env, stripping its dotenv-
# style surrounding quotes. Used below to get a handful of values in front
# of the container early (see the NEXT_PUBLIC_FIREBASE_*/AUTH_SECRET -e
# flags), without hardcoding a second copy of them that could drift from
# ci.env.
ci_env_value() {
  local line
  line="$(grep -m1 "^${1}=" "$ROOT/tools/e2e/ci.env" || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

# Fail loudly instead of silently dropping '-- <playwright args>': with
# forwardAllArgs:false, nx:run-commands ignores trailing CLI args entirely,
# so without this check the WHOLE suite would run regardless of what was
# passed after `--`. A scoped `--grep` silently never reaching Playwright is
# especially misleading during failure reproduction.
if [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
  NX_PROJECT_JSON="$(cd "$ROOT" && pnpm exec nx show project "$PROJECT" --json 2>/dev/null || true)"
  # jq's `//` alternative operator treats JSON `false` as falsy too (not just
  # null/missing), so `.forwardAllArgs // true` would silently turn a real
  # `false` back into `true`, defeating this exact check. Test presence with
  # `has()` instead.
  FORWARD_ALL_ARGS="$(printf '%s' "$NX_PROJECT_JSON" | jq -r '.targets["e2e-implementation"].options | if has("forwardAllArgs") then (.forwardAllArgs | tostring) else "true" end' 2>/dev/null || echo "unknown")"
  if [ "$FORWARD_ALL_ARGS" = "false" ]; then
    echo "e2e-docker: ERROR — '${PROJECT}:e2e-implementation' sets forwardAllArgs:false, so" >&2
    echo "the '-- ${PASSTHROUGH_ARGS[*]}' you passed would be silently dropped" >&2
    echo "and the WHOLE suite would run instead. Refusing to run." >&2
    echo >&2
    echo "Use E2E_GREP instead (read by this project's playwright.config.ts):" >&2
    echo "  E2E_GREP=\"<pattern>\" $0 $PROJECT" >&2
    exit 2
  elif [ "$FORWARD_ALL_ARGS" = "unknown" ]; then
    echo "e2e-docker: warning: couldn't determine '${PROJECT}:e2e-implementation's forwardAllArgs" >&2
    echo "via 'nx show project' (bad project name, or nx unavailable on the host)" >&2
    echo "— proceeding, but the passthrough args below may be silently dropped." >&2
  fi
fi

# When this script itself runs inside a container that talks to the HOST's
# docker daemon (this repo's own runner-autoscaler mounts the placement
# host's docker.sock into MountDockerSocket runners -- see
# apps/runner-autoscaler/scaler.go), `docker run -v SRC:DST` resolves SRC on
# the HOST filesystem, not in this container. Passing a container-local path
# therefore mounts a freshly-created empty host dir instead of the real repo.
#
# Map a container path to the host path backing it using /proc/self/mountinfo:
# the innermost mount containing the path gives (mount root on the source
# device, mount point); host path = root + (path minus mount point). This
# assumes the backing device is the host's root filesystem, which holds for
# plain bind mounts. Paths on the container's own overlay (or any tmpfs) have
# no host identity — fail loudly instead of letting docker mount an empty
# directory. Outside a container this is the identity. Escape hatch:
# E2E_DOCKER_PATH_TRANSLATE=0 (e.g. a true docker-in-docker daemon that
# really does see this container's filesystem).
#
# Also skipped entirely in DRY_RUN (agent-lcars#908): nothing gets mounted,
# so an accurate host path is pointless to compute -- and this repo's own
# self-hosted CI runners ARE containers (the JIT runner image), where /tmp is
# routinely tmpfs. tools/e2e-docker-isolation.test.sh's mktemp-based cache
# dirs hit exactly that "no host identity" refusal on those runners before
# this exemption existed, despite never touching Docker at all.
to_host_path() {
  local path="$1"
  if [ "$DRY_RUN" -eq 1 ] || [ ! -f /.dockerenv ] || [ "${E2E_DOCKER_PATH_TRANSLATE:-1}" = "0" ]; then
    printf '%s\n' "$path"
    return 0
  fi
  local match
  match=$(awk -v p="$path" '
    {
      mp = $5
      if (p == mp || index(p, mp == "/" ? "/" : mp "/") == 1) {
        fst = ""
        for (i = 7; i <= NF; i++) if ($i == "-") { fst = $(i + 1); break }
        if (length(mp) >= best) { best = length(mp); out = $4 "\t" mp "\t" fst }
      }
    }
    END { print out }
  ' /proc/self/mountinfo)
  local mroot mpoint fstype
  IFS=$'\t' read -r mroot mpoint fstype <<<"$match"
  case "$fstype" in
    ext4 | xfs | btrfs | zfs) ;;
    *)
      echo "e2e-docker: '$path' lives on '$fstype' at '$mpoint' inside this container," >&2
      echo "so the host docker daemon cannot bind-mount it. Put it under a host bind" >&2
      echo "mount (set E2E_DOCKER_CACHE_DIR) or set E2E_DOCKER_PATH_TRANSLATE=0." >&2
      exit 1
      ;;
  esac
  local suffix="${path#"$mpoint"}"
  printf '%s\n' "${mroot%/}${suffix}"
}

# Shared across ALL worktrees of this repo (a per-worktree cache would cost a
# cold multi-GB pnpm install + node_modules copy in every fresh worktree).
DK_DIR="${E2E_DOCKER_CACHE_DIR:-$HOME/.cache/agent-lcars-e2e-docker}"

# Tag derives from the Dockerfile's content, so any Dockerfile change yields a
# new tag. Must match homelab's publish-agent-lcars-images.sh derivation.
DOCKERFILE="$ROOT/tools/e2e/Dockerfile"
E2E_TAG="df-$(sha256sum "$DOCKERFILE" | cut -c1-12)"
IMAGE="${E2E_DOCKER_IMAGE:-docker-registry.lan.jlapenna.net/agent-lcars/e2e:${E2E_TAG}}"

# The node_modules mount is only correct for a given (lockfile, workspace
# package.json set, patches, image) tuple: hash the working-tree content of
# all of them, plus the resolved IMAGE reference itself -- not just E2E_TAG.
# Those differ only when E2E_DOCKER_IMAGE overrides the default; without this
# distinction, switching that override while E2E_TAG stays the same (nothing
# under tools/e2e/Dockerfile changed) would leave install.stamp unchanged too,
# so a later hit would reuse node_modules a DIFFERENT image had installed --
# possibly with a mismatched glibc/system-library set (Codex review, PR #924).
# Any mismatch (or a missing stamp/modules) means `pnpm install` must run; a
# match skips it entirely -- ported from sprinkles' install.stamp (#4049),
# ~470 lines lighter: no run.lock/suite.lock split and no MemTotal-sized
# concurrency slots, because those exist there to schedule seven suites
# against finite host memory and this repo has one (see this file's header
# comment).
#
# Computed before the registry pull below (unlike the code it's derived
# from) so the test hook right after it needs neither Docker nor network
# access -- IMAGE is already a resolved string at this point (no digest
# lookup), so this stays true even with the fix above.
compute_install_stamp() {
  (
    cd "$ROOT"
    printf '%s\n' "$IMAGE"
    git ls-files -- pnpm-lock.yaml pnpm-workspace.yaml .npmrc '*package.json' patches |
      while IFS= read -r f; do
        { [ -f "$f" ] && sha256sum -- "$f"; } || true
      done
  ) | sha256sum | cut -c1-16
}
DESIRED_STAMP="$(compute_install_stamp)"

# Test hook (tools/e2e-docker-isolation.test.sh): print the stamp this
# checkout would require and exit, so the stamp-hit/miss path is exercisable
# without Docker and without the test re-implementing this derivation.
if [ "${E2E_DOCKER_PRINT_STAMP:-}" = "1" ]; then
  printf '%s\n' "$DESIRED_STAMP"
  exit 0
fi

INSTALL_STAMP="$DK_DIR/install.stamp"

# Prefer whatever's already local (no network round-trip), else pull the
# published image (identical bytes everywhere -- this is what makes local
# screenshot runs trustworthy against CI's own baselines). Deliberately no
# local-build fallback (#908): a missing tag means either
# tools/e2e/Dockerfile changed and has not been published from canonical
# homelab yet (fix: merge it, then publish e2e and e2e-runner), or the
# registry is unreachable -- either way, silently spending several
# minutes on a local rebuild here masked both cases rather than surfacing
# them (the same tradeoff sprinkles' tools/e2e-docker.sh makes, and the
# reconciliation #908 exists to converge on).
if [ "$DRY_RUN" -eq 0 ] && ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo ">> e2e-docker: pulling $IMAGE ..." >&2
  if ! docker pull "$IMAGE"; then
    echo ">> e2e-docker: ERROR — $IMAGE not found locally or in the registry." >&2
    echo ">> If tools/e2e/Dockerfile changed on a branch that hasn't reached" >&2
    echo ">> main yet, merge it, then publish e2e and e2e-runner from" >&2
    echo ">> canonical homelab. Otherwise check connectivity to" >&2
    echo ">> docker-registry.lan.jlapenna.net." >&2
    exit 1
  fi
fi

# Isolated, host-user-owned dir the container can write to without perm
# issues. Also holds install.stamp and run.lock below. Skipped in DRY_RUN:
# it touches only the shared cache dir, not this checkout, but DRY_RUN's own
# contract (see header) is to touch nothing at all.
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$DK_DIR/node_modules" "$DK_DIR/home" "$DK_DIR/nx-cache"
fi

install_is_current() {
  [ -f "$INSTALL_STAMP" ] &&
    [ "$(cat "$INSTALL_STAMP")" = "$DESIRED_STAMP" ] &&
    [ -d "$DK_DIR/node_modules/.pnpm" ]
}

# Mount *sources* must be host paths (see to_host_path above); everything the
# e2e container sees stays at the usual /work-relative paths.
ROOT_HOST="$(to_host_path "$ROOT")"
DK_DIR_HOST="$(to_host_path "$DK_DIR")"

# node_modules MUST resolve *inside* /work: Turbopack's DiskFileSystem
# refuses any symlink whose target escapes its project root ("Symlink
# [project]/node_modules is invalid, it points out of the filesystem root"),
# which is exactly what a symlink to the sibling /e2e-cache mount below does.
# So unlike home/nx-cache, this one has to be a mount NESTED under /work --
# but pre-create the mount point here, as the invoking (unprivileged) user,
# so dockerd (root) reuses this directory rather than auto-creating a
# root-owned one directly on the host checkout the moment the container
# starts (the same host-poisoning failure guarded against below, just scoped
# to this one deliberately-tracked nested path).
#
# DESTRUCTIVE (see the file header's WARNING) -- gated on DRY_RUN like the
# rest of this section, so a dry run genuinely touches nothing on disk.
if [ "$DRY_RUN" -eq 0 ]; then
  rm -rf "$ROOT/node_modules"
  mkdir -p "$ROOT/node_modules"
fi

# Resource caps so an overweight run (Next build + emulator JVM + Chromium +
# parallel nx workers) is OOM-killed *inside* the container instead of
# starving the host. 12g is sized for the Next.js production build (the
# heaviest step); 8g intermittently OOM-kills it.
MEM="${E2E_DOCKER_MEMORY:-12g}"
MEM_SWAP="${E2E_DOCKER_MEMORY_SWAP:-14g}"
PIDS="${E2E_DOCKER_PIDS:-8192}"

QUOTED_PASSTHROUGH=""
if [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
  QUOTED_PASSTHROUGH=" -- $(printf '%q ' "${PASSTHROUGH_ARGS[@]}")"
fi

# The install step, when it runs, writes the stamp itself -- gated on `pnpm
# install` actually succeeding, and BEFORE `nx run` starts, so a suite
# failure (a real test failure, not a dependency problem) still leaves the
# next invocation able to skip straight to the suite.
decide_install_step() {
  if install_is_current; then
    INSTALL_NOTE="dependencies current (install.stamp hit); skipping pnpm install"
    INNER_CMD="pnpm exec nx run ${PROJECT}:e2e-implementation${QUOTED_PASSTHROUGH}"
  else
    INSTALL_NOTE="installing dependencies (install.stamp miss)"
    INNER_CMD="pnpm install --frozen-lockfile && echo -n ${DESIRED_STAMP} > /e2e-cache/install.stamp && pnpm exec nx run ${PROJECT}:e2e-implementation${QUOTED_PASSTHROUGH}"
  fi
}

# For DRY_RUN only: decide now, purely for display -- see the real path
# below for why this decision is deferred until the lock is held there.
if [ "$DRY_RUN" -eq 1 ]; then
  decide_install_step
fi

# Deliberately NOT --network host: the emulators, dev server, and Playwright
# all run inside this one container and only ever talk to each other over its
# own loopback, so nothing outside needs the fixed ports (4200/9099/8080/...)
# published on the host. The default bridge network gives each run its own
# namespace for free.
#
# $DK_DIR_HOST/{home,nx-cache} mount at a TOP-LEVEL container path (a sibling
# of /work, not nested under it) -- deliberately, not just for tidiness.
# /work is itself a bind mount of the host checkout; nesting a -v UNDER it
# whose target doesn't already exist makes dockerd (root) auto-create that
# mount-point directory *directly on the host checkout* before --user ever
# takes effect, leaving a root-owned directory the host's normal user can
# never remove. Mounting at a non-nested path means dockerd creates THIS
# mount point in the container's own layer instead, never touching the host
# checkout. node_modules can't join them here (Turbopack, see above) -- it
# gets its own nested mount instead, onto the directory pre-created above
# specifically to avoid this same trap.
DOCKER_ARGS=(
  run --rm -t
  --ipc=host
  --memory="$MEM"
  --memory-swap="$MEM_SWAP"
  --pids-limit="$PIDS"
  --user "$(id -u):$(id -g)"
  -v "$ROOT_HOST:/work"
  -v "$DK_DIR_HOST/node_modules:/work/node_modules"
  -v "$DK_DIR_HOST:/e2e-cache"
  -e HOME=/e2e-cache/home
  -e NX_CACHE_DIRECTORY=/e2e-cache/nx-cache
  -e NX_MAX_PARALLEL="${NX_MAX_PARALLEL:-2}"
  -e NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
  -e HUSKY=0
  -e CI=1
  -e E2E_GREP="${E2E_GREP:-}"
  -e E2E_HERMETIC=1
  -e NX_LOAD_DOT_ENV_FILES=false
  -e E2E_ENV_FILE=/work/tools/e2e/ci.env
  -e E2E_ENV_LOCAL_FILE=/e2e-cache/home/.env.e2e.local
  -e AUTH_SECRET="$(ci_env_value AUTH_SECRET)"
  -w /work
  "$IMAGE"
)
# bash -lc "$INNER_CMD" is appended separately below, once INNER_CMD is
# actually decided -- see the two branches' own comments for why that
# decision point differs between DRY_RUN and the real path.

if [ "$DRY_RUN" -eq 1 ]; then
  echo ">> e2e-docker: DRY RUN — image: $IMAGE" >&2
  echo ">> e2e-docker: DRY RUN — $INSTALL_NOTE" >&2
  echo ">> e2e-docker: DRY RUN — would run:" >&2
  echo "docker"
  for arg in "${DOCKER_ARGS[@]}" bash -lc "$INNER_CMD"; do
    printf '%s\n' "$arg"
  done
  echo ">> inner command: $INNER_CMD" >&2
  exit 0
fi

# A single exclusive flock for the whole invocation -- $DK_DIR is shared
# across every worktree of this checkout, so this serializes every
# e2e-docker.sh run against the one node_modules mount and test-output paths
# they all share, the same shape tools/e2e-local.sh already uses for its own
# host-direct run (see that script's own lock). Non-blocking first so a
# human sees an immediate, actionable message instead of silently hanging.
RUN_LOCK="$DK_DIR/run.lock"
exec {RUN_LOCK_FD}>"$RUN_LOCK"
if ! flock -n -x "$RUN_LOCK_FD"; then
  echo ">> e2e-docker: another e2e-docker run is using this checkout's shared cache" >&2
  echo ">> ($DK_DIR, across every worktree) -- waiting for it to finish..." >&2
  flock -x "$RUN_LOCK_FD"
fi

# Only NOW -- holding the lock -- is it safe to decide whether install.stamp
# is current: deciding earlier would race a concurrent run that finishes its
# own install and updates the stamp while this one was still waiting on the
# lock above, making this run redundantly reinstall dependencies the other
# invocation had just made current.
decide_install_step

echo ">> e2e-docker: $INSTALL_NOTE" >&2
echo ">> running ${PROJECT}:e2e-implementation in container (mem=$MEM) ..."
exec docker "${DOCKER_ARGS[@]}" bash -lc "$INNER_CMD"
