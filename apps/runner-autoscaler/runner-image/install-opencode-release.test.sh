#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install-opencode-release.sh
source "$here/install-opencode-release.sh"

fail_test() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

assert_release() {
  local arch="$1"
  local expected_asset="$2"
  local expected_digest="$3"
  local actual_asset actual_digest

  IFS=$'\t' read -r actual_asset actual_digest < <(
    select_opencode_release v1.18.25 "$arch"
  )
  [[ "$actual_asset" == "$expected_asset" && "$actual_digest" == "$expected_digest" ]] ||
    fail_test "wrong reviewed release selection for $arch"
}

assert_release amd64 opencode-linux-x64.tar.gz \
  58a3729a6f3432dd6d2917fcc4a949788891a035818646ad480e12c947f56e78
assert_release arm64 opencode-linux-arm64.tar.gz \
  35ef77897425e41b5183a2c21ac4fb1d4d944d82a94e3c920f57b5490af11ac5
if (select_opencode_release v1.18.25 ppc64le) >/dev/null 2>&1; then
  fail_test 'unsupported target architecture was accepted'
fi
if (select_opencode_release v1.18.26 amd64) >/dev/null 2>&1; then
  fail_test 'unreviewed version was accepted'
fi

mkdir -p "$tmp/valid" "$tmp/unsafe-path/nested" "$tmp/symlink"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$tmp/valid/opencode"
chmod +x "$tmp/valid/opencode"
tar -C "$tmp/valid" -czf "$tmp/valid.tar.gz" opencode
valid_digest="$(sha256sum "$tmp/valid.tar.gz" | awk '{print $1}')"
validate_opencode_archive "$tmp/valid.tar.gz" "$valid_digest"

if (validate_opencode_archive "$tmp/valid.tar.gz" \
  0000000000000000000000000000000000000000000000000000000000000000) >/dev/null 2>&1; then
  fail_test 'digest mismatch was accepted'
fi

printf '%s\n' 'unexpected' > "$tmp/unsafe-path/nested/opencode"
tar -C "$tmp/unsafe-path" -czf "$tmp/unsafe-path.tar.gz" nested/opencode
unsafe_path_digest="$(sha256sum "$tmp/unsafe-path.tar.gz" | awk '{print $1}')"
if (validate_opencode_archive "$tmp/unsafe-path.tar.gz" "$unsafe_path_digest") >/dev/null 2>&1; then
  fail_test 'archive with a nonexact path was accepted'
fi

ln -s /etc/passwd "$tmp/symlink/opencode"
tar -C "$tmp/symlink" -czf "$tmp/symlink.tar.gz" opencode
symlink_digest="$(sha256sum "$tmp/symlink.tar.gz" | awk '{print $1}')"
if (validate_opencode_archive "$tmp/symlink.tar.gz" "$symlink_digest") >/dev/null 2>&1; then
  fail_test 'archive with a symlinked opencode entry was accepted'
fi

echo 'install-opencode-release.test.sh: all cases passed'
