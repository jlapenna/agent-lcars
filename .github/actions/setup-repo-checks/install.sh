#!/usr/bin/env bash
# Native tools keep the fleet's ephemeral workers socketless. Install only in
# RUNNER_TEMP, never into the checkout or the host's system toolchain.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo 'Only Linux runners are supported.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=amd64; gitleaks_arch=x64; shellcheck_arch=x86_64
    shellcheck_sha=6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87 ;;
  aarch64|arm64) arch=arm64; gitleaks_arch=arm64; shellcheck_arch=aarch64
    shellcheck_sha=324a7e89de8fa2aed0d0c28f3dab59cf84c6d74264022c00c22af665ed1a09bb ;;
  *) echo 'Unsupported runner architecture.' >&2; exit 1 ;;
esac
case "${CHECK_TOOL:?}" in
  gitleaks|actionlint) ;;
  *) echo 'tool must be gitleaks or actionlint.' >&2; exit 1 ;;
esac
[[ "${ACTIONLINT_VERSION:-1.7.7}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
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
  release_binary gitleaks/gitleaks 8.18.2 \
    "gitleaks_8.18.2_linux_${gitleaks_arch}.tar.gz" gitleaks_8.18.2_checksums.txt gitleaks
  bin/gitleaks version
else
  version="${ACTIONLINT_VERSION:-1.7.7}"
  release_binary rhysd/actionlint "$version" \
    "actionlint_${version}_linux_${arch}.tar.gz" "actionlint_${version}_checksums.txt" actionlint
  asset="shellcheck-v0.10.0.linux.${shellcheck_arch}.tar.xz"
  curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/koalaman/shellcheck/releases/download/v0.10.0/$asset" -o "$asset"
  printf '%s  %s\n' "$shellcheck_sha" "$asset" | sha256sum --check
  tar -xJf "$asset" --strip-components=1 -C bin shellcheck-v0.10.0/shellcheck
  # Keep both embedded-script analyzers from the former actionlint image.
  # --target works with externally-managed Python and needs no sudo/venv.
  python3 -m pip install --disable-pip-version-check --no-compile \
    --target "$install_dir/python" pyflakes==3.2.0
  printf '#!/usr/bin/env bash\nexport PYTHONPATH=%q\nexec python3 -m pyflakes "$@"\n' \
    "$install_dir/python" > bin/pyflakes
  chmod +x bin/pyflakes
  bin/actionlint -version
  bin/shellcheck --version
  bin/pyflakes --version
fi
printf '%s\n' "$install_dir/bin" >> "${GITHUB_PATH:?}"
