#!/usr/bin/env bash
#
# Runs an e2e project's Playwright suite inside the pinned Docker environment
# (tools/e2e/Dockerfile) instead of on the host, so screenshot rendering is
# identical to CI. Local/interactive use only -- apps/console-e2e's own
# playwright.config.ts auto-skips @visual specs entirely outside of CI/Docker
# for exactly this reason.
#
# WARNING: this replaces the host checkout's node_modules/ with an empty
# directory (see the Turbopack note below) so the container can mount its own
# in its place. Run `pnpm install` again afterward before using this checkout
# for anything on the host directly.
#
# Ported from members' tools/e2e-docker.sh (this repo's origin, #2373 Phase
# 2's hardening), trimmed to agent-lcars' single e2e project and simplified
# where members' version depends on infra this repo doesn't have (a
# registry-published image, a multi-frontend port list). The Docker-in-Docker
# path translation, resource caps, and forwardAllArgs safety check below are
# kept as-is: they fix real, previously-hit failures, not stylistic choices.
#
# Usage:
#   tools/e2e-docker.sh <nx-project> [--update] [-- <playwright args>]
#   E2E_GREP="pattern" tools/e2e-docker.sh <nx-project> [--update]
#
#   --update            regenerate screenshot baselines (UPDATE_SNAPSHOTS=1,
#                       read by playwright.config.ts). With no E2E_GREP
#                       scoping this rewrites EVERY spec's baselines in the
#                       suite -- prints a loud warning (and, interactively,
#                       pauses 5s) when it detects that combination.
#   -- <playwright args> forwarded verbatim to the underlying `nx e2e` run --
#                        only takes effect if that project's `e2e` target
#                        does NOT set `forwardAllArgs: false`. This repo's
#                        console-e2e DOES set it (its `command` is a single
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
#                       container and read by playwright.config.ts (mirrors
#                       the existing SKIP_VISUAL/VISUAL_ONLY pattern) to
#                       scope a run to one spec/suite without regenerating
#                       every other spec's snapshots.
#
# Resource caps (override for bigger/smaller machines):
#   E2E_DOCKER_MEMORY=12g  E2E_DOCKER_MEMORY_SWAP=14g  E2E_DOCKER_PIDS=8192
#   NX_MAX_PARALLEL=2      NODE_OPTIONS=--max-old-space-size=8192
#
# Most app config (AUTH_ENABLED, DEBUG, LOCAL, etc.) comes from .env.e2e,
# which the `e2e` target's own command already loads via
# `pnpm exec dotenv -e .env.e2e -e .env.e2e.local --optional`. This script
# materializes .env.e2e from tools/e2e/ci.env's dummy values the first time
# (never overwriting one you've customized locally, same as a fresh
# checkout's first local e2e run) rather than passing them as `docker run -e`/
# `--env-file` flags: ci.env's KEY="value" quoting is dotenv syntax, and
# `docker --env-file` does NOT strip those quotes the way dotenv does, so the
# values would arrive with literal quote characters baked in.
#
# NEXT_PUBLIC_FIREBASE_*/AUTH_SECRET are the one exception: they're passed as
# real `docker run -e` flags below (sourced from ci.env via ci_env_value, not
# hardcoded) rather than left to the .env.e2e file above. Next.js inlines
# NEXT_PUBLIC_* at `next build` time -- which runs as part of `nx run
# <project>:e2e`'s dependsOn chain, BEFORE the dotenv-wrapped
# `firebase emulators:exec "..."` command that actually loads .env.e2e ever
# starts -- and Auth.js reads AUTH_SECRET just as early, during the
# production server's own initialization. Left to only .env.e2e, both would
# silently bake in as empty/undefined.
#
# Because the host glibc differs from the container's, the container gets its
# own node_modules and pnpm store (shared across worktrees under
# ~/.cache/agent-lcars-e2e-docker; override with E2E_DOCKER_CACHE_DIR) so
# host-built native binaries are never reused inside the container and vice
# versa -- without paying a cold install per worktree.
set -euo pipefail

PROJECT="${1:?usage: tools/e2e-docker.sh <nx-project> [--update] [-- <playwright args>]}"
shift || true

UPDATE_ENV=()
PASSTHROUGH_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --update) UPDATE_ENV=(-e UPDATE_SNAPSHOTS=1) ;;
    --)
      shift
      PASSTHROUGH_ARGS=("$@")
      break
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# Also honor an ambient UPDATE_SNAPSHOTS=1 so baselines can be refreshed
# without --update (e.g. a CI label-driven run).
if [ "${UPDATE_SNAPSHOTS:-}" = "1" ]; then
  UPDATE_ENV=(-e UPDATE_SNAPSHOTS=1)
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
# passed after `--` -- exactly how members#2448 rewrote unrelated specs'
# screenshot baselines (a scoped `--grep` silently never reached Playwright).
if [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
  NX_PROJECT_JSON="$(cd "$ROOT" && pnpm exec nx show project "$PROJECT" --json 2>/dev/null || true)"
  # jq's `//` alternative operator treats JSON `false` as falsy too (not just
  # null/missing), so `.forwardAllArgs // true` would silently turn a real
  # `false` back into `true`, defeating this exact check. Test presence with
  # `has()` instead.
  FORWARD_ALL_ARGS="$(printf '%s' "$NX_PROJECT_JSON" | jq -r '.targets.e2e.options | if has("forwardAllArgs") then (.forwardAllArgs | tostring) else "true" end' 2>/dev/null || echo "unknown")"
  if [ "$FORWARD_ALL_ARGS" = "false" ]; then
    echo "e2e-docker: ERROR — '${PROJECT}:e2e' sets forwardAllArgs:false, so" >&2
    echo "the '-- ${PASSTHROUGH_ARGS[*]}' you passed would be silently dropped" >&2
    echo "and the WHOLE suite would run instead. Refusing to run." >&2
    echo >&2
    echo "Use E2E_GREP instead (read by this project's playwright.config.ts):" >&2
    UPDATE_SUFFIX=""
    if [ "${#UPDATE_ENV[@]}" -gt 0 ]; then
      UPDATE_SUFFIX=" --update"
    fi
    echo "  E2E_GREP=\"<pattern>\" $0 $PROJECT${UPDATE_SUFFIX}" >&2
    exit 2
  elif [ "$FORWARD_ALL_ARGS" = "unknown" ]; then
    echo "e2e-docker: warning: couldn't determine '${PROJECT}:e2e's forwardAllArgs" >&2
    echo "via 'nx show project' (bad project name, or nx unavailable on the host)" >&2
    echo "— proceeding, but the passthrough args below may be silently dropped." >&2
  fi
fi

# Loud (non-blocking) warning when a baseline regen has no scoping at all --
# UPDATE_SNAPSHOTS=1 with neither E2E_GREP nor (now-validated) passthrough
# args rewrites EVERY screenshot in the suite. Only pause for confirmation
# when a human is actually watching a real terminal.
if [ "${#UPDATE_ENV[@]}" -gt 0 ] && [ -z "${E2E_GREP:-}" ] && [ "${#PASSTHROUGH_ARGS[@]}" -eq 0 ]; then
  echo "############################################################" >&2
  echo "# e2e-docker: WARNING — regenerating screenshot baselines" >&2
  echo "# for the ENTIRE '${PROJECT}' suite. No E2E_GREP scoping is" >&2
  echo "# set, so every spec's snapshots will be overwritten, not" >&2
  echo "# just the one you're working on." >&2
  echo "#" >&2
  echo "# To scope this to one spec/suite instead:" >&2
  echo "#   E2E_GREP=\"pattern\" $0 $PROJECT --update" >&2
  echo "############################################################" >&2
  if [ -z "${CI:-}" ] && [ -t 0 ]; then
    echo ">> Ctrl-C now to abort, or wait 5s to continue with the full-suite regen..." >&2
    sleep 5
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
to_host_path() {
  local path="$1"
  if [ ! -f /.dockerenv ] || [ "${E2E_DOCKER_PATH_TRANSLATE:-1}" = "0" ]; then
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
# Caveat: two SIMULTANEOUS docker e2e runs from different worktrees would
# race on the shared node_modules; run one at a time (the resource caps below
# make parallel local runs impractical anyway).
DK_DIR="${E2E_DOCKER_CACHE_DIR:-$HOME/.cache/agent-lcars-e2e-docker}"

DOCKERFILE="$ROOT/tools/e2e/Dockerfile"
IMAGE_TAG="agent-lcars-e2e:$(sha256sum "$DOCKERFILE" | cut -c1-12)"

if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo ">> building $IMAGE_TAG ..."
  docker build -t "$IMAGE_TAG" -f "$DOCKERFILE" "$ROOT/tools/e2e"
fi

# Isolated, host-user-owned dirs the container can write to without perm issues.
mkdir -p "$DK_DIR/node_modules" "$DK_DIR/home" "$DK_DIR/nx-cache"

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
rm -rf "$ROOT/node_modules"
mkdir -p "$ROOT/node_modules"

# Resource caps so an overweight run (Next build + emulator JVM + Chromium +
# parallel nx workers) is OOM-killed *inside* the container instead of
# starving the host. 12g is sized for the Next.js production build (the
# heaviest step); 8g intermittently OOM-kills it.
MEM="${E2E_DOCKER_MEMORY:-12g}"
MEM_SWAP="${E2E_DOCKER_MEMORY_SWAP:-14g}"
PIDS="${E2E_DOCKER_PIDS:-8192}"

echo ">> running ${PROJECT}:e2e in container (${UPDATE_ENV[*]:-no-update}; mem=$MEM) ..."

QUOTED_PASSTHROUGH=""
if [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
  QUOTED_PASSTHROUGH=" -- $(printf '%q ' "${PASSTHROUGH_ARGS[@]}")"
fi

# Deliberately NOT --network host: the emulators, dev server, and Playwright
# all run inside this one container and only ever talk to each other over its
# own loopback, so nothing outside needs the fixed ports (4200/9099/8080/...)
# published on the host. The default bridge network gives each run its own
# namespace for free (still races on the shared node_modules/cache dir above
# if run concurrently from the same DK_DIR -- that's unrelated).
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
exec docker run --rm -t \
  --ipc=host \
  --memory="$MEM" \
  --memory-swap="$MEM_SWAP" \
  --pids-limit="$PIDS" \
  --user "$(id -u):$(id -g)" \
  -v "$ROOT_HOST":/work \
  -v "$DK_DIR_HOST/node_modules":/work/node_modules \
  -v "$DK_DIR_HOST":/e2e-cache \
  -e HOME=/e2e-cache/home \
  -e NX_CACHE_DIRECTORY=/e2e-cache/nx-cache \
  -e NX_MAX_PARALLEL="${NX_MAX_PARALLEL:-2}" \
  -e NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}" \
  -e HUSKY=0 \
  -e CI=1 \
  -e VISUAL_ONLY="${VISUAL_ONLY:-}" \
  -e SKIP_VISUAL="${SKIP_VISUAL:-}" \
  -e E2E_GREP="${E2E_GREP:-}" \
  -e AUTH_SECRET="$(ci_env_value AUTH_SECRET)" \
  -e NEXT_PUBLIC_FIREBASE_API_KEY="$(ci_env_value NEXT_PUBLIC_FIREBASE_API_KEY)" \
  -e NEXT_PUBLIC_FIREBASE_APP_ID="$(ci_env_value NEXT_PUBLIC_FIREBASE_APP_ID)" \
  -e NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="$(ci_env_value NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN)" \
  -e NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST="$(ci_env_value NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST)" \
  -e NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="$(ci_env_value NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID)" \
  -e NEXT_PUBLIC_FIREBASE_PROJECT_ID="$(ci_env_value NEXT_PUBLIC_FIREBASE_PROJECT_ID)" \
  -e NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="$(ci_env_value NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET)" \
  "${UPDATE_ENV[@]}" \
  -w /work \
  "$IMAGE_TAG" \
  bash -lc "[ -f .env.e2e ] || cp tools/e2e/ci.env .env.e2e && pnpm install --frozen-lockfile && pnpm exec nx run ${PROJECT}:e2e${QUOTED_PASSTHROUGH}"
