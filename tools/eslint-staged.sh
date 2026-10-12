#!/usr/bin/env bash
set -euo pipefail

export NX_TUI=false
export NX_DAEMON=false

# ESLint reads Nx's cached project graph. Recompute it against the same
# staged-visible worktree that ESLint will lint, without resetting caches.
./tools/nx show projects --json >/dev/null

exec pnpm exec eslint --fix --max-warnings=0 --no-warn-ignored "$@"
