#!/usr/bin/env bash
# Install the generated Husky bootstrap for this checkout.
set -euo pipefail

# CI runners do not need local commit/push hooks, and some CI installs disable
# lifecycle scripts. Local installs must always regenerate the ignored Husky
# directory before anyone relies on the checkout's Git guards.
if [ -n "${CI:-}" ]; then
  exit 0
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# setup-worktree.sh deliberately installs dependencies with HUSKY=0. Remove
# that setting here so this explicit initialization step cannot silently skip
# hook generation.
env -u HUSKY pnpm exec husky
./tools/assert-git-hooks-installed.sh
