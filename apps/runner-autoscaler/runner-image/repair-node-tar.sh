#!/usr/bin/env bash
# Replace the npm-bundled node-tar copies inherited from the Actions runner
# image and NodeSource. The upstream runner payload carries its own Node 20 and
# Node 24 npm installations, so updating only the system npm leaves two
# vulnerable copies behind.
set -euo pipefail

readonly fixed_version="7.5.22"
readonly work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

npm install --prefix "$work_dir" --no-save --ignore-scripts \
  --install-strategy=nested "tar@${fixed_version}"

for tar_target in \
  /usr/lib/node_modules/npm/node_modules/tar \
  /home/runner/externals/node24/lib/node_modules/npm/node_modules/tar \
  /home/runner/externals/node20/lib/node_modules/npm/node_modules/tar; do
  test -f "${tar_target}/package.json"
  rm -rf "${tar_target}"
  mkdir -p "${tar_target}"
  cp -a "${work_dir}/node_modules/tar/." "${tar_target}"
  test "$(node -p "require(process.argv[1]).version" "${tar_target}/package.json")" = "$fixed_version"
done
