#!/usr/bin/env bash
# chezmoi for homegit's `validate` job (jlapenna/homelab#3510). That job is
# homegit's required check and its rollout gate, and it fetched this release
# from GitHub on every run. The job uses this binary only while its version
# equals the workflow's own pin, so move the two together: an image that is
# ahead or behind costs the job a download, never a different result.
set -euo pipefail
: "${CHEZMOI_VERSION:?CHEZMOI_VERSION required}"
[[ "$CHEZMOI_VERSION" == 2.72.0 ]] || { echo 'No reviewed chezmoi checksum for version' >&2; exit 1; }
case "${TARGETARCH:?TARGETARCH required}" in
  amd64) digest=0d6665b96c527d57fdc562bf19e808f80f48c2d977062c03e3e65c6b09eafbce ;;
  arm64) digest=e79a27621256390f03166d3965e6a1946f983a096c4d90f02c43d2aa5b563728 ;;
  *) echo 'Unsupported chezmoi architecture' >&2; exit 1 ;;
esac
chezmoi_install_tmp="$(mktemp -d)"
trap 'rm -rf -- "$chezmoi_install_tmp"' EXIT
curl --fail --location --retry 2 --max-time 180 --max-filesize 67108864 \
  "https://github.com/twpayne/chezmoi/releases/download/v$CHEZMOI_VERSION/chezmoi_${CHEZMOI_VERSION}_linux_${TARGETARCH}.tar.gz" -o "$chezmoi_install_tmp/release.tar.gz"
printf '%s  %s\n' "$digest" "$chezmoi_install_tmp/release.tar.gz" | sha256sum --check --status
[[ "$(tar -tvzf "$chezmoi_install_tmp/release.tar.gz" chezmoi | cut -c1)" == '-' ]]
tar -xzf "$chezmoi_install_tmp/release.tar.gz" -C "$chezmoi_install_tmp" chezmoi
install -d "${CHEZMOI_INSTALL_DIR:-/usr/local/bin}"
install -m 0755 "$chezmoi_install_tmp/chezmoi" "${CHEZMOI_INSTALL_DIR:-/usr/local/bin}/chezmoi"
"${CHEZMOI_INSTALL_DIR:-/usr/local/bin}/chezmoi" --version | grep -Eq "^chezmoi version v${CHEZMOI_VERSION//./\\.},"
