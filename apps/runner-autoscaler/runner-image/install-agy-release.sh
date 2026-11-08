#!/usr/bin/env bash
# Same reviewed-release installation path as the other supported runtimes.
set -euo pipefail
: "${AGY_VERSION:?AGY_VERSION required}"
[[ "$AGY_VERSION" == 1.5.1 ]] || { echo 'No reviewed Antigravity CLI checksum for version' >&2; exit 1; }
case "${TARGETARCH:?TARGETARCH required}" in
  amd64) asset=agy_cli_linux_x64.tar.gz; digest=2a64ccfc5f6679c253769f0760614af5de04d8dc1eeeec9b9752ba4c8dd92250 ;;
  arm64) asset=agy_cli_linux_arm64.tar.gz; digest=c43a50831006d95a7637aa9cad7000fda9b9bb4b3ece8c53cc6c5089b92542ea ;;
  *) echo 'Unsupported Antigravity CLI architecture' >&2; exit 1 ;;
esac
agy_install_tmp="$(mktemp -d)"
trap 'rm -rf -- "$agy_install_tmp"' EXIT
curl --fail --location --retry 2 --max-time 180 --max-filesize 83886080 \
  "https://github.com/google-antigravity/antigravity-cli/releases/download/$AGY_VERSION/$asset" -o "$agy_install_tmp/release.tar.gz"
printf '%s  %s\n' "$digest" "$agy_install_tmp/release.tar.gz" | sha256sum --check --status
[[ "$(tar -tzf "$agy_install_tmp/release.tar.gz")" == 'antigravity' ]]
[[ "$(LC_ALL=C tar -tvzf "$agy_install_tmp/release.tar.gz" antigravity | cut -c1)" == '-' ]]
tar -xzf "$agy_install_tmp/release.tar.gz" --no-same-owner --no-same-permissions -C "$agy_install_tmp" -- antigravity
install -d "${AGY_INSTALL_DIR:-/usr/local/bin}"
install -m 0755 "$agy_install_tmp/antigravity" "${AGY_INSTALL_DIR:-/usr/local/bin}/agy"
"${AGY_INSTALL_DIR:-/usr/local/bin}/agy" --version | awk '{$1=$1; print}' | grep -Fx "$AGY_VERSION"
