#!/usr/bin/env bash
# Daemon-free OCI tooling, pinned to the upstream release asset's SHA-256.
set -euo pipefail
[[ $# == 1 && $(uname -s) == Linux ]] || { echo 'usage: install-crane.sh DESTINATION (Linux)' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=x86_64; digest=0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0 ;;
  aarch64|arm64) arch=arm64; digest=898c0cff975f898a33e8c4580bdafb0e7c02c7faa33374e946762f97c4ab7110 ;;
  *) echo 'unsupported crane architecture' >&2; exit 1 ;;
esac
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
curl --fail --location --silent --show-error --max-time 60 \
  "https://github.com/google/go-containerregistry/releases/download/v0.22.1/go-containerregistry_Linux_${arch}.tar.gz" -o "$archive"
printf '%s  %s\n' "$digest" "$archive" | sha256sum -c -
mkdir -p "$1"
tar -xzf "$archive" -C "$1" crane
