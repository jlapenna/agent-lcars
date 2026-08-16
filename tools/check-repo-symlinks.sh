#!/usr/bin/env bash
# Fail if the repo contains a symlink cycle or a dangling symlink. `find -L`
# (follow-symlinks) resolves every symlink it walks and only re-prints an
# entry as type `l` when it could NOT resolve it -- exactly a broken target
# or a cycle. That is the #1255 incident's failure signature: a
# self-referential symlink under `.agents/skills/` checked out clean through
# this repo's own CI, then broke every consumer's whole-repo
# `uses: jlapenna/agent-lcars/...@main` action download at 'Set up job'
# (issue #1265) -- invisible here, fleet-breaking downstream.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

unresolved="$(find -L . -mindepth 1 -name .git -prune -o -type l -print)"

if [ -n "$unresolved" ]; then
  echo "ERROR: found symlink(s) that are broken or form a cycle:" >&2
  echo "$unresolved" >&2
  exit 1
fi

echo "ok: no dangling symlinks or symlink cycles found"
