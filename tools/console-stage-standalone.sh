#!/usr/bin/env bash
# Next's standalone trace omits the static and public assets it serves.
set -euo pipefail

build=dist/apps/console/.next
standalone="$build/standalone"
mkdir -p "$standalone/$build" "$standalone/apps/console"
cp -r apps/console/public "$standalone/apps/console/"
cp -r "$build/static" "$standalone/$build/"
