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

expected='REVISION SHA256SUMS lcars lcars-events-agent.cjs lcars-hook-flush.cjs lcars-hook.cjs lcars-session-title.cjs'
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
# `events agent --help` loads the whole events-agent bundle, Pub/Sub client
# included, and prints its usage without starting the agent.
events_usage="$(run events agent --help)" ||
  fail 'the events-agent bundle exited non-zero for --help'
grep -q 'Usage: lcars events agent' <<<"$events_usage" ||
  fail 'the launcher did not reach the events-agent bundle'
# The flusher holds the Firestore client and is only ever started by the
# other bundles, from the file beside them. `session archive --help` starts
# it that way and prints its usage without touching the network, which
# proves the whole bundle loads and is found where the launcher puts it.
flusher_usage="$(run session archive --help)" ||
  fail 'the flusher bundle did not load from beside the CLI bundle'
grep -q 'usage: lcars session archive' <<<"$flusher_usage" ||
  fail 'the session-title bundle did not reach the flusher bundle'

echo "Verified $archive at $(cat "$lib/REVISION")"
