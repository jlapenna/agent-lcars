#!/usr/bin/env bash
# Unpacks a workstation CLI archive the way a workstation receives it and
# proves the launcher can run what is inside, before it is published.
#
# Usage: verify-workstation-cli.sh ARCHIVE
#
# Runs offline and writes only under a throwaway HOME. `lcars hook` exits 0
# whatever happens, by design, so its exit status proves nothing: each check
# below reads what the bundle printed instead.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: verify-workstation-cli.sh ARCHIVE" >&2
  exit 2
fi
archive="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT
lib="$home/.local/share/agent-lcars-cli"
mkdir -p "$lib"
tar -xzf "$archive" -C "$lib"

fail() {
  echo "workstation CLI archive: $*" >&2
  exit 1
}

expected='REVISION SHA256SUMS lcars lcars-hook-flush.cjs lcars-hook.cjs lcars-session-title.cjs'
actual="$(cd "$lib" && find . -mindepth 1 -printf '%P\n' | LC_ALL=C sort | tr '\n' ' ')"
[ "${actual% }" = "$expected" ] || fail "holds '${actual% }', expected '$expected'"

(cd "$lib" && sha256sum --check --quiet SHA256SUMS) || fail 'SHA256SUMS does not match its contents'
[[ "$(cat "$lib/REVISION")" =~ ^[0-9a-f]{40}$ ]] || fail 'REVISION is not a commit'
[ -x "$lib/lcars" ] || fail 'the launcher is not executable'

# A workstation's own state and credentials must not reach these runs.
run() {
  env -i PATH="$PATH" HOME="$home" "$lib/lcars" "$@" </dev/null 2>&1
}

# Captured first: a `grep -q` that stops reading early would fail the pipe.
help="$(run --help)" || fail 'the session-title bundle exited non-zero for --help'
grep -q 'session title' <<<"$help" ||
  fail 'the launcher did not reach the session-title bundle'
hook_usage="$(run hook)" || fail 'the hook bundle exited non-zero'
grep -q 'usage: lcars hook claude' <<<"$hook_usage" ||
  fail 'the launcher did not reach the hook bundle'
# The flusher holds the Firestore client and is spawned by the hook, never
# run directly here: check that Node can parse it.
node --check "$lib/lcars-hook-flush.cjs" || fail 'the flusher bundle does not parse'

echo "Verified $archive at $(cat "$lib/REVISION")"
