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
