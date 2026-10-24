#!/usr/bin/env bash
# Native tools keep the fleet's ephemeral workers socketless. Install only in
# RUNNER_TEMP, never into the checkout or the host's system toolchain.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The action download includes the repository's shared image-owned pins.
# shellcheck source=../../../apps/runner-autoscaler/runner-image/repo-checks.env
source "$here/../../../apps/runner-autoscaler/runner-image/repo-checks.env"
case "${TOOL_SOURCE-install}" in
  baked|install) ;;
  *) echo 'tool-source must be baked or install.' >&2; exit 1 ;;
esac

[[ "$(uname -s)" == Linux ]] || { echo 'Only Linux runners are supported.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=amd64; gitleaks_arch=x64; shellcheck_arch=x86_64
    shellcheck_sha="$SHELLCHECK_SHA_AMD64" ;;
  aarch64|arm64) arch=arm64; gitleaks_arch=arm64; shellcheck_arch=aarch64
    shellcheck_sha="$SHELLCHECK_SHA_ARM64" ;;
  *) echo 'Unsupported runner architecture.' >&2; exit 1 ;;
esac
case "${CHECK_TOOL:?}" in
  gitleaks|actionlint) ;;
  *) echo 'tool must be gitleaks or actionlint.' >&2; exit 1 ;;
esac
[[ "${ACTIONLINT_VERSION:-1.7.12}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
# Baked mode is validation only: never create a package target or fall back.
require_version() {
  local binary="$1" expected="$2" output
  shift 2
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "baked $binary is missing (expected $expected)." >&2
    exit 1
  fi
  output="$("$binary" "$@")" || { echo "baked $binary failed to report its version." >&2; exit 1; }
  case "$binary" in
    gitleaks) output="$(printf '%s\n' "$output" | head -n 1)" ;;
    actionlint|pyflakes) output="$(printf '%s\n' "$output" | head -n 1 | awk '{print $1}')" ;;
    shellcheck) output="$(printf '%s\n' "$output" | sed -n 's/^version: //p')" ;;
  esac
  [[ "$binary" != actionlint ]] || output="${output#v}"
  [[ "$output" == "$expected" ]] || {
    echo "baked $binary version mismatch: expected $expected, got $output." >&2
    exit 1
  }
}
if [[ "${TOOL_SOURCE-install}" == baked ]]; then
  if [[ "$CHECK_TOOL" == gitleaks ]]; then
    require_version gitleaks "$GITLEAKS_VERSION" version
  else
    require_version actionlint "${ACTIONLINT_VERSION:-1.7.12}" -version
    require_version shellcheck "$SHELLCHECK_VERSION" --version
    require_version pyflakes "$PYFLAKES_VERSION" --version
  fi
  exit 0
fi

install_dir="$(mktemp -d "${RUNNER_TEMP:?}/repo-checks.XXXXXX")"
mkdir "$install_dir/bin"
cd "$install_dir"

# Verify the selected release asset before extracting just its executable.
release_binary() {
  local repository="$1" version="$2" asset="$3" checksums="$4" binary="$5"
  local url="https://github.com/$repository/releases/download/v$version"
  curl --fail --silent --show-error --location --retry 3 "$url/$asset" -o "$asset"
  curl --fail --silent --show-error --location --retry 3 "$url/$checksums" -o checksums.txt
  awk -v asset="$asset" '$2 == asset { print }' checksums.txt > selected.sha256
  [[ "$(wc -l < selected.sha256)" -eq 1 ]]
  sha256sum --check selected.sha256
  tar -xzf "$asset" -C bin "$binary"
}

if [[ "$CHECK_TOOL" == gitleaks ]]; then
  release_binary gitleaks/gitleaks "$GITLEAKS_VERSION" \
    "gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" gitleaks
  bin/gitleaks version
else
  version="${ACTIONLINT_VERSION:-1.7.12}"
  release_binary rhysd/actionlint "$version" \
    "actionlint_${version}_linux_${arch}.tar.gz" "actionlint_${version}_checksums.txt" actionlint
  asset="shellcheck-v${SHELLCHECK_VERSION}.linux.${shellcheck_arch}.tar.xz"
  curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/$asset" -o "$asset"
  printf '%s  %s\n' "$shellcheck_sha" "$asset" | sha256sum --check
  tar -xJf "$asset" --strip-components=1 -C bin shellcheck-v${SHELLCHECK_VERSION}/shellcheck
  # Keep both embedded-script analyzers from the former actionlint image.
  # --target works with externally-managed Python and needs no sudo/venv.
  python3 -m pip install --disable-pip-version-check --no-compile \
    --target "$install_dir/python" "pyflakes==$PYFLAKES_VERSION"
  printf '#!/usr/bin/env bash\nexport PYTHONPATH=%q\nexec python3 -m pyflakes "$@"\n' \
    "$install_dir/python" > bin/pyflakes
  chmod +x bin/pyflakes
  bin/actionlint -version
  bin/shellcheck --version
  bin/pyflakes --version
fi
printf '%s\n' "$install_dir/bin" >> "${GITHUB_PATH:?}"
