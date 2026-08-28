#!/usr/bin/env bash
# Install the reviewed OpenCode release into the runner image's trusted path.
#
# This is deliberately separate from .github/actions/setup-opencode/install.sh:
# that action runs as the job user and follows OpenCode's supported installer,
# while this runs as root during image construction. Do not make this script
# accept a mutable installer, PATH result, or an unpinned release selection.
set -euo pipefail

readonly OPENCODE_RELEASE_OWNER='anomalyco'
readonly OPENCODE_RELEASE_REPOSITORY='opencode'
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
  local asset digest

  case "$arch" in
    amd64)
      asset='opencode-linux-x64.tar.gz'
      digest='58a3729a6f3432dd6d2917fcc4a949788891a035818646ad480e12c947f56e78'
      ;;
    arm64)
      asset='opencode-linux-arm64.tar.gz'
      digest='35ef77897425e41b5183a2c21ac4fb1d4d944d82a94e3c920f57b5490af11ac5'
      ;;
    *)
      fail "unsupported target architecture: $arch"
      ;;
  esac

  # The checksum review is intentionally tied to the exact version below.
  # A version bump must add its own reviewed digest rather than silently
  # reusing these bytes.
  if [[ "$version" != 'v1.18.25' ]]; then
    fail "no reviewed OpenCode artifact digest for $version"
  fi

  printf '%s\t%s\n' "$asset" "$digest"
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

  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    --connect-timeout 30 --max-time 570 \
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
