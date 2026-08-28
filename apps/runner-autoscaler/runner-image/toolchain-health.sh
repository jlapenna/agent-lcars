#!/bin/sh
# Runtime toolchain predicates for the JIT runner image. Sourced by
# entrypoint.sh rather than executed so boot can refuse GitHub registration
# when a required job tool is absent or broken (#468).

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

# Firebase's Firestore emulator rejects Java runtimes older than 21. Keep the
# check at the image boundary so a damaged or regressed JRE fails before the
# runner registers and accepts an E2E job it cannot complete.
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
# only as a shell-test seam; runner boot always passes the literal path.
trusted_opencode_runs() {
  local opencode_command="${1:-/usr/local/bin/opencode}"
  [ -x "$opencode_command" ] && "$opencode_command" --version >/dev/null 2>&1
}
