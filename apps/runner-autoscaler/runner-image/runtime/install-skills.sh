#!/usr/bin/env bash
# Native QueueExecutor layer-1 skill installer.
# Installs the layer-1 skill surface into the runner user's skills directory
# (#1269). Layer 1 is an explicit list, not "everything in the directory":
# layer 3 is repo dev/ops tooling and must never travel.
#
# Runs once, at image build (#2033), so a missing or unreadable skill is an
# image-build failure rather than a per-dispatch warning. Every container
# starts from that verified layer; prepare-dispatch.sh only digests what the
# image already holds.
set -euo pipefail
SRC="${1:?usage: install-skills.sh <source-skills-root> <dest-skills-dir>}"
DEST="${2:?usage: install-skills.sh <source-skills-root> <dest-skills-dir>}"
LIST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/layer1-skills.conf"

if [ ! -f "$LIST" ]; then
  echo "install-skills: $LIST is missing" >&2
  exit 1
fi
mkdir -p "$DEST"

installed=0
while read -r name; do
  [ -n "$name" ] || continue
  case "$name" in \#*) continue ;; esac
  if [ ! -f "$SRC/$name/SKILL.md" ]; then
    echo "install-skills: layer-1 skill '$name' has no SKILL.md under $SRC" >&2
    exit 1
  fi
  rm -rf "${DEST:?}/$name"
  cp -R "$SRC/$name" "$DEST/$name"
  installed=$((installed + 1))
done < "$LIST"

if [ "$installed" -eq 0 ]; then
  echo "install-skills: $LIST names no skills" >&2
  exit 1
fi
echo "install-skills: installed $installed layer-1 skill(s) into $DEST"
