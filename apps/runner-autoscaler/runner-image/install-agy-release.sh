#!/usr/bin/env bash
# Same reviewed-release installation path as the other supported runtimes.
set -euo pipefail
: "${AGY_VERSION:?AGY_VERSION required}"
[[ "$AGY_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected an exact Antigravity CLI version' >&2; exit 1; }
case "${TARGETARCH:?TARGETARCH required}" in
  amd64) asset=agy_cli_linux_x64.tar.gz ;;
  arm64) asset=agy_cli_linux_arm64.tar.gz ;;
  *) echo 'Unsupported Antigravity CLI architecture' >&2; exit 1 ;;
esac
manifest="$(dirname "${BASH_SOURCE[0]}")/runtime-releases.json"
digest="$(jq -er --arg version "$AGY_VERSION" --arg arch "$TARGETARCH" --arg asset "$asset" '
  [.releases[] | select(.repository == "google-antigravity/antigravity-cli" and .version == $version and .architecture == $arch)]
  | if length == 1 then .[0] else error("expected one platform release") end
  | select(.asset == $asset and (.sha256 | test("^[a-f0-9]{64}$"))) | .sha256
' "$manifest")" || { echo 'No reviewed Antigravity CLI checksum for version/platform' >&2; exit 1; }
agy_install_tmp="$(mktemp -d)"
trap 'rm -rf -- "$agy_install_tmp"' EXIT
# v1.5.9's largest archive is 99,166,075 bytes; retain a bounded 104 MiB window.
curl --fail --location --retry 2 --max-time 180 --max-filesize 109051904 \
  "https://github.com/google-antigravity/antigravity-cli/releases/download/$AGY_VERSION/$asset" -o "$agy_install_tmp/release.tar.gz"
printf '%s  %s\n' "$digest" "$agy_install_tmp/release.tar.gz" | sha256sum --check --status
[[ "$(tar -tzf "$agy_install_tmp/release.tar.gz")" == 'antigravity' ]]
[[ "$(LC_ALL=C tar -tvzf "$agy_install_tmp/release.tar.gz" antigravity | cut -c1)" == '-' ]]
tar -xzf "$agy_install_tmp/release.tar.gz" --no-same-owner --no-same-permissions -C "$agy_install_tmp" -- antigravity
install -d "${AGY_INSTALL_DIR:-/usr/local/bin}"
install -m 0755 "$agy_install_tmp/antigravity" "${AGY_INSTALL_DIR:-/usr/local/bin}/agy"
"${AGY_INSTALL_DIR:-/usr/local/bin}/agy" --version | awk '{$1=$1; print}' | grep -Fx "$AGY_VERSION"
