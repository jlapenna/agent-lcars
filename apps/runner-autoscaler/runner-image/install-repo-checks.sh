#!/usr/bin/env bash
# Fetch target-platform scanner releases on the native ci-tooling builder.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=repo-checks.env
source "$here/repo-checks.env"
case "${TARGETARCH:?}" in
  amd64) gitleaks_arch=x64; shellcheck_arch=x86_64; shellcheck_sha="$SHELLCHECK_SHA_AMD64" ;;
  arm64) gitleaks_arch=arm64; shellcheck_arch=aarch64; shellcheck_sha="$SHELLCHECK_SHA_ARM64" ;;
  *) echo "Unsupported scanner architecture: $TARGETARCH" >&2; exit 1 ;;
esac
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
mkdir -p /out
asset="gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION"
curl -fsSL --retry 3 "$url/$asset" -o "$asset"
curl -fsSL --retry 3 "$url/gitleaks_${GITLEAKS_VERSION}_checksums.txt" -o checksums.txt
awk -v asset="$asset" '$2 == asset { print }' checksums.txt > selected.sha256
[[ "$(wc -l < selected.sha256)" -eq 1 ]]
sha256sum --check selected.sha256
tar -xzf "$asset" -C /out gitleaks
asset="shellcheck-v${SHELLCHECK_VERSION}.linux.${shellcheck_arch}.tar.xz"
curl -fsSL --retry 3 "https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK_VERSION/$asset" -o "$asset"
printf '%s  %s\n' "$shellcheck_sha" "$asset" | sha256sum --check
tar -xJf "$asset" --strip-components=1 -C /out "shellcheck-v${SHELLCHECK_VERSION}/shellcheck"
chown 0:0 /out/gitleaks /out/shellcheck
chmod 0755 /out/gitleaks /out/shellcheck
