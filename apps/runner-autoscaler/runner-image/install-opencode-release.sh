#!/usr/bin/env bash
# Install the reviewed OpenCode release into the runner image's trusted path.
#
# This runs as root during image construction. Do not make this script accept
# a mutable installer, PATH result, or an unpinned release selection.
set -euo pipefail

readonly OPENCODE_RELEASE_OWNER='anomalyco'
readonly OPENCODE_RELEASE_REPOSITORY='opencode'
# v2.3.2's largest reviewed archive is the 122,641,607-byte amd64 baseline
# release. Keep a small bounded margin without permitting unbounded downloads.
readonly OPENCODE_MAX_ARCHIVE_BYTES=134217728
readonly OPENCODE_DOWNLOAD_BUDGET_SECONDS=600
readonly OPENCODE_RETRY_MAX_SECONDS=570
opencode_temp_dir=''

fail() {
  echo "OpenCode release install failed: $*" >&2
  exit 1
}

cleanup_opencode_temp_dir() {
  if [[ -n "$opencode_temp_dir" ]]; then
    rm -rf -- "$opencode_temp_dir"
  fi
}

select_opencode_release() {
  local version="$1"
  local arch="$2"
  local asset release
  local manifest="${3:-$(dirname "${BASH_SOURCE[0]}")/runtime-releases.json}"

  case "$arch" in
    amd64)
      asset='opencode-linux-x64-baseline.tar.gz'
      ;;
    arm64)
      asset='opencode-linux-arm64.tar.gz'
      ;;
    *)
      fail "unsupported target architecture: $arch"
      ;;
  esac

  # Renovate updates the version and each platform digest together. A missing,
  # ambiguous or mismatched lock entry fails before any download.
  release="$(jq -er --arg version "$version" --arg arch "$arch" --arg asset "$asset" '
    [.releases[] | select(.repository == "anomalyco/opencode" and .version == $version and .architecture == $arch)]
    | if length == 1 then .[0] else error("expected one platform release") end
    | select(.asset == $asset and (.sha256 | test("^[a-f0-9]{64}$")))
    | [.asset, .sha256] | @tsv
  ' "$manifest")" || fail "no reviewed OpenCode artifact digest for $version/$arch"
  printf '%s\n' "$release"
}

validate_opencode_archive() {
  local archive="$1"
  local expected_digest="$2"
  local members member_type

  printf '%s  %s\n' "$expected_digest" "$archive" | sha256sum --check --status ||
    fail 'SHA-256 does not match the reviewed release artifact'

  members="$(tar -tzf "$archive")" || fail 'cannot list release archive'
  [[ "$members" == 'opencode' ]] ||
    fail 'release archive must contain exactly the safe opencode path'

  # A lone safe pathname is not sufficient: reject symlinks, hard links, and
  # directories before extraction so tar never installs an archive-controlled
  # path target. The expected release is one regular file.
  member_type="$(LC_ALL=C tar -tvzf "$archive" | cut -c1)" ||
    fail 'cannot inspect release archive member type'
  [[ "$member_type" == '-' ]] ||
    fail 'release archive opencode entry must be a regular file'
}

install_opencode_release() {
  local version="$1"
  local arch="$2"
  local asset digest release archive

  release="$(select_opencode_release "$version" "$arch")" ||
    fail "cannot select reviewed release for $version/$arch"
  IFS=$'\t' read -r asset digest <<< "$release" ||
    fail 'reviewed release selection is malformed'
  opencode_temp_dir="$(mktemp -d)"
  archive="$opencode_temp_dir/$asset"
  trap cleanup_opencode_temp_dir EXIT

  timeout -k 30s "${OPENCODE_DOWNLOAD_BUDGET_SECONDS}s" \
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      --retry-max-time "$OPENCODE_RETRY_MAX_SECONDS" \
      --connect-timeout 30 --max-time "$OPENCODE_RETRY_MAX_SECONDS" \
      --max-filesize "$OPENCODE_MAX_ARCHIVE_BYTES" \
      "https://github.com/$OPENCODE_RELEASE_OWNER/$OPENCODE_RELEASE_REPOSITORY/releases/download/$version/$asset" \
      --output "$archive"
  validate_opencode_archive "$archive" "$digest"
  tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$opencode_temp_dir" -- opencode
  install -o root -g root -m 0755 "$opencode_temp_dir/opencode" /usr/local/bin/opencode
}

main() {
  : "${OPENCODE_VERSION:?OPENCODE_VERSION is required}"
  : "${TARGETARCH:?TARGETARCH is required}"
  [[ "$OPENCODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail 'OPENCODE_VERSION must be an exact v-prefixed semantic release'
  install_opencode_release "$OPENCODE_VERSION" "$TARGETARCH"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
