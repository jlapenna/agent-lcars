#!/usr/bin/env bash
# Install agent skills that ship inside pinned npm devDependencies into
# .agents/skills (the copies are gitignored). package.json pins each package
# and Renovate bumps it, so the installed skill always matches the lockfile
# without a vendored copy or a symlink that dangles before install. Runs from
# postinstall; a package missing from node_modules (for example a production
# install without devDependencies) is skipped.
#
# Upstream skill text tells agents to run `<runner> <package>@latest`. The
# copy is rewritten to the exact installed version, so agents run the
# lockfile-pinned CLI (which passed the fleet's release-age policy), and the
# invocation carries DISABLE_TELEMETRY=1 because skipping the upstream
# installer also skips its telemetry notice. The rewrite fails closed: any
# remaining `@latest` reference aborts the install.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# <package> <skill directory under the package's skills/>
sync_skill() {
  local package="$1" skill="$2"
  local src="node_modules/$package/skills/$skill" dest=".agents/skills/$skill"
  [ -f "$src/SKILL.md" ] || return 0
  local version
  version="$(node -p "require('./node_modules/$package/package.json').version")"

  rm -rf "$dest"
  mkdir -p .agents/skills
  cp -RL "$src" "$dest"

  local runners='(npx -y |npx |pnpx |pnpm dlx |pnpm exec |bunx |yarn dlx )'
  local files=()
  mapfile -d '' files < <(grep -rlZF -- "$package@latest" "$dest" || true)
  if [ "${#files[@]}" -gt 0 ]; then
    sed -E -i \
      -e "s#(DISABLE_TELEMETRY=1 )?$runners$package@latest#DISABLE_TELEMETRY=1 \\2$package@$version#g" \
      -e "s#$package@latest#$package@$version#g" \
      "${files[@]}"
  fi
  if grep -rqF -- "$package@latest" "$dest"; then
    echo "sync-package-skills: unpinned $package@latest remains in $dest" >&2
    exit 1
  fi
}

sync_skill modern-web-guidance modern-web-guidance
