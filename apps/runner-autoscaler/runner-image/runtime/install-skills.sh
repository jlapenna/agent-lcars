#!/usr/bin/env bash
# Native QueueExecutor runtime skill installer.
# Installs the layer-1 skill surface into a dispatched agent's skills
# directory (#1269). Layer 1 is an explicit list, not "everything in the
# directory": layer 3 is repo dev/ops tooling and must never travel.
#
# Fail-soft by contract -- guidance delivery must never fail the agent job
# it is instrumenting, so every failure path warns and exits 0.
set -u
SRC="${1:?usage: install-skills.sh <source-skills-root> <dest-skills-dir>}"
DEST="${2:?usage: install-skills.sh <source-skills-root> <dest-skills-dir>}"
LIST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/layer1-skills.conf"

if [ ! -f "$LIST" ]; then
  echo "::warning::layer1-skills.conf missing; skipping skill install." >&2
  exit 0
fi
mkdir -p "$DEST" 2>/dev/null || { echo "::warning::cannot create $DEST; skipping skill install." >&2; exit 0; }

installed=""
while read -r name; do
  [ -n "$name" ] || continue
  case "$name" in \#*) continue ;; esac
  if [ ! -d "$SRC/$name" ]; then
    echo "::warning::layer-1 skill '$name' not found under $SRC; skipping it." >&2
    continue
  fi
  rm -rf "${DEST:?}/$name"
  cp -R "$SRC/$name" "$DEST/$name" || { echo "::warning::failed to install '$name'." >&2; continue; }
  installed="$installed $name"
done < "$LIST"

# Digest the installed content, not the source: this is the record of what
# the agent actually received, which is the only thing worth reporting.
find "$DEST" -type f -print0 2>/dev/null \
  | sort -z \
  | xargs -0 sha256sum 2>/dev/null \
  | sha256sum \
  | cut -d' ' -f1
exit 0
