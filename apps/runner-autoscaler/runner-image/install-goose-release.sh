#!/usr/bin/env bash
# Same reviewed-release installation path as the other supported runtimes.
set -euo pipefail
: "${GOOSE_VERSION:?GOOSE_VERSION required}"
[[ "$GOOSE_VERSION" == v1.56.0 ]] || { echo 'No reviewed Goose checksum for version' >&2; exit 1; }
case "${TARGETARCH:?TARGETARCH required}" in
  amd64) arch=x86_64; digest=80e7716fef3dccc3fef6850e24e5b846b7340e10e13098e53b4f47769f5803ef ;;
  arm64) arch=aarch64; digest=a3e86032aa147aa511b0d996e4540bcd19baf037c66f33f995a2127edc935ec3 ;;
  *) echo 'Unsupported Goose architecture' >&2; exit 1 ;;
esac
goose_install_tmp="$(mktemp -d)"
trap 'rm -rf -- "$goose_install_tmp"' EXIT
curl --fail --location --retry 2 --max-time 180 --max-filesize 67108864 \
  "https://github.com/aaif-goose/goose/releases/download/$GOOSE_VERSION/goose-$arch-unknown-linux-musl.tar.gz" -o "$goose_install_tmp/release.tar.gz"
printf '%s  %s\n' "$digest" "$goose_install_tmp/release.tar.gz" | sha256sum --check --status
[[ "$(tar -tzf "$goose_install_tmp/release.tar.gz")" == $'./\n./goose' ]]
[[ "$(tar -tvzf "$goose_install_tmp/release.tar.gz" ./goose | cut -c1)" == '-' ]]
tar -xzf "$goose_install_tmp/release.tar.gz" -C "$goose_install_tmp" ./goose
install -d "${GOOSE_INSTALL_DIR:-/usr/local/bin}"
install -m 0755 "$goose_install_tmp/goose" "${GOOSE_INSTALL_DIR:-/usr/local/bin}/goose"
"${GOOSE_INSTALL_DIR:-/usr/local/bin}/goose" --version | awk '{$1=$1; print}' | grep -Fx "${GOOSE_VERSION#v}"
