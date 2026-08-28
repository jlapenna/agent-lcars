#!/usr/bin/env bash
# Installs one explicitly selected OpenCode release beneath the caller's HOME.
# The composite action owns release resolution and PATH publication; the
# runner image owns promotion of this resulting binary into /usr/local/bin.
set -euo pipefail

: "${OPENCODE_VERSION:?OPENCODE_VERSION is required}"
if ! [[ "$OPENCODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "OPENCODE_VERSION must be an exact v-prefixed semantic release" >&2
  exit 1
fi

timeout -k 30s 10m bash -o pipefail -c \
  'curl --connect-timeout 30 --max-time 570 -fsSL https://opencode.ai/install |
    bash -s -- --version "$OPENCODE_VERSION" --no-modify-path'
