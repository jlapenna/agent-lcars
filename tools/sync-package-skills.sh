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

stage=""
cleanup_stage() { if [ -n "$stage" ]; then rm -rf "$stage"; fi; }
trap cleanup_stage EXIT

# <package> <skill directory under the package's skills/>
sync_skill() {
  local package="$1" skill="$2"
  local src="node_modules/$package/skills/$skill" dest=".agents/skills/$skill"
  [ -f "$src/SKILL.md" ] || return 0
  local version
  version="$(node -p "require('./node_modules/$package/package.json').version")"

  # Stage and verify the rewritten copy before it replaces the installed
  # skill, so a failed check never leaves an unpinned copy for agents to load.
  mkdir -p .agents/skills
  stage="$(mktemp -d .agents/skills/.sync-XXXXXX)"
  cp -RL "$src" "$stage/$skill"

  local runners='(npx -y |npx |pnpx |pnpm dlx |pnpm exec |bunx |yarn dlx )'
  local files=()
  mapfile -d '' files < <(grep -rlZF -- "$package@latest" "$stage/$skill" || true)
  if [ "${#files[@]}" -gt 0 ]; then
    sed -E -i \
      -e "s#(DISABLE_TELEMETRY=1 )?$runners$package@latest#DISABLE_TELEMETRY=1 \\2$package@$version#g" \
      -e "s#$package@latest#$package@$version#g" \
      "${files[@]}"
  fi
  if grep -rqF -- "$package@latest" "$stage/$skill"; then
    rm -rf "$dest"
    echo "sync-package-skills: unpinned $package@latest remains in $skill; not installed" >&2
    exit 1
  fi

  rm -rf "$dest"
  mv "$stage/$skill" "$dest"
}

sync_skill modern-web-guidance modern-web-guidance
