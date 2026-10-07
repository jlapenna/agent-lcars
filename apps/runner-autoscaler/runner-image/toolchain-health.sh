#!/bin/sh
# Toolchain predicates for the JIT runner image. Sourced by
# verify-image-invariants.sh at image build so an image whose required job
# tool is absent or broken is never published (#468, #2033).

pnpm_runs() {
  # Corepack selects the repo-pinned pnpm version from this manifest. From an
  # arbitrary directory it instead asks the registry for `pnpm/latest`, which
  # would turn an offline health check into a false failure. Keep the caller's
  # cwd unchanged while exercising the exact artifact warmed during the build.
  (
    cd "${AGENT_LCARS_COREPACK_DIR:-/usr/local/share/agent-lcars-corepack}" 2>/dev/null &&
      command -v pnpm >/dev/null 2>&1 &&
      pnpm --version >/dev/null 2>&1
  )
}

# Every fleet-pinned pnpm recorded at build time, and the image default used
# outside any project (this repo's own pin), must resolve from the baked
# Corepack cache with the registry disabled. A miss here is a per-job download.
pinned_pnpm_runs_offline() (
  dir="${AGENT_LCARS_COREPACK_DIR:-/usr/local/share/agent-lcars-corepack}"
  [ -s "$dir/fleet-pnpm-pins" ] && command -v pnpm >/dev/null 2>&1 || return 1
  scratch="$(mktemp -d)" || return 1
  trap 'rm -rf "$scratch"' EXIT
  resolves() {
    [ -n "$2" ] && [ "$(cd "$1" && COREPACK_ENABLE_NETWORK=0 pnpm --version 2>/dev/null)" = "$2" ]
  }
  version_of() { sed -nE 's/^pnpm@([0-9]+\.[0-9]+\.[0-9]+)([+].*)?$/\1/p' <<<"$1"; }

  default_pin="$(node -p "require('$dir/package.json').packageManager" 2>/dev/null)"
  resolves "$scratch" "$(version_of "$default_pin")" || return 1
  while IFS= read -r pin; do
    mkdir "$scratch/project"
    printf '{"packageManager":"%s"}\n' "$pin" >"$scratch/project/package.json"
    resolves "$scratch/project" "$(version_of "$pin")" || return 1
    rm -rf "$scratch/project"
  done <"$dir/fleet-pnpm-pins"
)

# Firebase's Firestore emulator rejects Java runtimes older than 21. Keep the
# check at the image boundary so a damaged or regressed JRE fails the image
# build instead of an E2E job it cannot complete.
java_21_runs() (
  java_command="${AGENT_LCARS_JAVA_COMMAND:-java}"
  command -v "$java_command" >/dev/null 2>&1 || return 1

  java_output="$("$java_command" -version 2>&1)" || return 1
  java_major="$(
    printf '%s\n' "$java_output" |
      sed -nE 's/.*version "([0-9]+)(\.[^"]*)?".*/\1/p' |
      head -n 1
  )"

  case "$java_major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$java_major" -ge 21 ]
)

# The telemetry watcher intentionally invokes this exact image-owned binary,
# never PATH or an agent-writable action install. Keep the command parameter
# only as a shell-test seam; the image gate always passes the literal path.
trusted_opencode_runs() {
  local opencode_command="${1:-/usr/local/bin/opencode}"
  [ -x "$opencode_command" ] && "$opencode_command" --version >/dev/null 2>&1
}

# QueueExecutor invokes OpenCode through its ordinary non-interactive CLI,
# with --auto approving permissions not explicitly denied. Keep that contract
# at the image boundary: a reviewed CLI upgrade that drops or renames the
# flag must fail the image build rather than accepting work and dying after
# checkout.
trusted_opencode_supports_auto() {
  local opencode_command="${1:-/usr/local/bin/opencode}"
  [ -x "$opencode_command" ] &&
    "$opencode_command" run --help 2>&1 | grep -Fq -- '--auto'
}
