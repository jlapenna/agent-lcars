#!/usr/bin/env bash
# Packs the workstation `lcars` CLI -- the four bundles and their launcher --
# into the archive enrolled workstations install.
#
# .github/workflows/publish-workstation-cli.yml runs this after `main` passes
# CI and publishes the result as the `workstation-cli` release asset. Homegit
# unpacks that asset at ~/.local/share/agent-lcars-cli and links
# ~/.local/bin/lcars to the launcher inside it, so the launcher names that
# directory. It is not ~/.local/lib/agent-lcars, where the development
# installer writes: homegit will not unpack over files it did not write. See
# the Workstation CLI row in docs/deployment-boundary.md.
#
# Usage: package-workstation-cli.sh OUT_DIR REVISION [DIST_DIR]
#   OUT_DIR   receives lcars-workstation-cli.tar.gz and SHA256SUMS.
#   REVISION  the 40-character commit the bundles were built from.
#   DIST_DIR  where the built bundles are; defaults to this checkout's
#             dist/apps. Build them first:
#               ./tools/nx run-many -t session-title-cli hook-cli hook-flush-cli \
#                 events-agent-cli \
#                 -p @agent-lcars/telemetry-watcher
#
# SHA256SUMS covers the launcher and the bundles and nothing else, so it
# changes only when what a workstation runs changes. The publisher compares
# it with the published copy to decide whether there is anything new to ship.
# REVISION, inside the archive, is the commit that last changed it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: package-workstation-cli.sh OUT_DIR REVISION [DIST_DIR]" >&2
  exit 2
fi
out_dir="$1"
revision="$2"
dist_dir="${3:-$REPO_ROOT/dist/apps}"

if ! [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "REVISION must be a 40-character commit, got '$revision'." >&2
  exit 2
fi

# Launcher first: the installed directory's contents, in the order listed.
contents=(lcars lcars-hook.cjs lcars-hook-flush.cjs lcars-session-title.cjs lcars-events-agent.cjs)

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

built_bundle() {
  case "$1" in
    lcars-hook.cjs) echo "$dist_dir/telemetry-watcher-hook/$1" ;;
    lcars-hook-flush.cjs) echo "$dist_dir/telemetry-watcher-hook-flush/$1" ;;
    lcars-session-title.cjs) echo "$dist_dir/telemetry-watcher-session-title-cli/$1" ;;
    lcars-events-agent.cjs) echo "$dist_dir/telemetry-watcher-events-agent/$1" ;;
  esac
}

for name in "${contents[@]:1}"; do
  built="$(built_bundle "$name")"
  if [ ! -s "$built" ]; then
    echo "$built is missing or empty -- build the CLI targets first." >&2
    exit 1
  fi
  install -m 0644 "$built" "$stage/$name"
done

# shellcheck source=apps/telemetry-watcher/bin/lcars-launcher.sh
. "$SCRIPT_DIR/lcars-launcher.sh"
# Single-quoted on purpose: the launcher expands $HOME when it runs.
# shellcheck disable=SC2016
write_lcars_launcher "$stage/lcars" '$HOME/.local/share/agent-lcars-cli' \
  'jlapenna/agent-lcars apps/telemetry-watcher/bin/package-workstation-cli.sh; homegit installs and refreshes this file'

(cd "$stage" && sha256sum "${contents[@]}") >"$stage/SHA256SUMS"
printf '%s\n' "$revision" >"$stage/REVISION"
# Not left to the caller's umask, which would change the archive's bytes.
chmod 0644 "$stage/SHA256SUMS" "$stage/REVISION"

mkdir -p "$out_dir"
# Fixed order, owner and times: the same content packs to the same bytes.
tar --sort=name --mtime='2020-01-01 00:00:00Z' --owner=0 --group=0 --numeric-owner \
  -C "$stage" -cf - "${contents[@]}" SHA256SUMS REVISION |
  gzip -n >"$out_dir/lcars-workstation-cli.tar.gz"
install -m 0644 "$stage/SHA256SUMS" "$out_dir/SHA256SUMS"

echo "Packed $out_dir/lcars-workstation-cli.tar.gz for $revision"
