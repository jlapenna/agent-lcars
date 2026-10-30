#!/usr/bin/env bash
# Replace the npm-bundled node-tar copies inherited from the Actions runner
# image and NodeSource. The retained runner Node 24 npm installation is
# independent of system npm and must receive the same repair.
#
# The NodeSource system npm is also upgraded to a release whose bundled
# dependencies (undici, brace-expansion, ip-address, pacote, minimatch) carry
# the fixes for the runner-image CVE findings (#3116). The runner's externals
# npm is upstream-owned and only gets the tar repair.
set -euo pipefail

readonly fixed_version="7.5.22"
readonly npm_version="11.21.1"
readonly work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

npm install --global "npm@${npm_version}"
test "$(node -p "require('/usr/lib/node_modules/npm/package.json').version")" = "$npm_version"

npm install --prefix "$work_dir" --no-save --ignore-scripts \
  --install-strategy=nested "tar@${fixed_version}"

for tar_target in \
  /usr/lib/node_modules/npm/node_modules/tar \
  /home/runner/externals/node24/lib/node_modules/npm/node_modules/tar; do
  test -f "${tar_target}/package.json"
  rm -rf "${tar_target}"
  mkdir -p "${tar_target}"
  cp -a "${work_dir}/node_modules/tar/." "${tar_target}"
  test "$(node -p "require(process.argv[1]).version" "${tar_target}/package.json")" = "$fixed_version"
done
