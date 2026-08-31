#!/bin/bash
#
# Fast production `next build` smoke for apps/console-affected pushes.
#
# Why this exists (#537): scoped vitest + typecheck are structurally blind
# to RSC client/server boundary bugs - a component reference passed as a
# prop across the server->client line, a 'use client' module dragging in a
# server-deps module, server code calling a client-module export. All of
# those surface as build/prerender failures, but the pre-push fast layer
# (format:check + affected lint/typecheck) never runs a build, so they
# previously weren't caught until CI's Verify job or the hermetic e2e suite
# - minutes later, and the same shape of bug shipped four times in one
# night (retro #521).
#
# This runs the real `@nx/next:build` production build - the same one CI
# runs - so it catches anything a build actually exercises: bundler
# resolution failures and prerenderable server/client boundary breaks.
# Measured at ~15-30s uncached (apps/console alone, warm deps), so it's a
# deliberate, narrow exception to this repo's "pre-push doesn't build"
# rule (see agent-lcars-dev's verify.md), scoped tightly enough not to
# matter in practice: it only runs at all when apps/console is affected by
# the push, and Nx caches the result like any other task.
#
# What it does NOT catch: a bug that only manifests at request time on a
# route the build doesn't prerender, or a purely client-side/browser
# navigation bug (#503's cross-page DOM duplication) - CI's required E2E
# gate catches those. `console-e2e:e2e-local` remains an optional diagnostic
# reproduction tool (see verify.md's Console e2e section).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export NX_TUI=false
export NX_DAEMON=false

affected_json="$(./tools/nx show projects --affected --base=origin/main --projects '@agent-lcars/console' --json 2>/dev/null)" || affected_json='[]'

# Parse as JSON rather than string-matching nx's plain-text list output,
# which isn't a documented format and isn't worth trusting to stay `[]`
# for "nothing matched" across nx versions. `--json` is explicit and
# stable; treat any parse failure as "not affected" (fail open - a smoke
# step shouldn't block the push because its own affected-check hiccuped).
affected_count="$(printf '%s' "$affected_json" | jq 'length' 2>/dev/null)" || affected_count=0

if [ "$affected_count" -eq 0 ]; then
  exit 0
fi

echo "apps/console is affected - building and probing the deployable standalone bundle (#537, #736)..."
./tools/nx run @agent-lcars/console:bundle
./tools/console-standalone-smoke.sh
