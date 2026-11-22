#!/usr/bin/env bash
# Install agent skills that ship inside pinned npm devDependencies into
# .agents/skills (the copies are gitignored). package.json pins each package
# and Renovate bumps it, so the installed skill always matches the lockfile
# without a vendored copy or a symlink that dangles before install. Runs from
# postinstall; a package missing from node_modules (for example a production
# install without devDependencies) is skipped.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# <package> <skill directory under the package's skills/>
sync_skill() {
  local src="node_modules/$1/skills/$2" dest=".agents/skills/$2"
  [ -f "$src/SKILL.md" ] || return 0
  rm -rf "$dest"
  mkdir -p .agents/skills
  cp -RL "$src" "$dest"
}

sync_skill modern-web-guidance modern-web-guidance
