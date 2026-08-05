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
# navigation bug (#503's cross-page DOM duplication) - those need
# `console-e2e:e2e-local` (see verify.md's Console e2e section).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export NX_TUI=false
export NX_DAEMON=false

affected="$(./tools/nx show projects --affected --base=origin/main --projects '@agent-lcars/console' 2>/dev/null || true)"

# `nx show projects --projects '@agent-lcars/console'` only ever matches
# that exact project (confirmed empirically: it does not also match
# '@agent-lcars/console-e2e'), so the only two possible outputs here are
# the literal empty-array string `[]` or the single-element array
# containing it - not an empty string, so don't test with `-z`.
if [ "$affected" = '[]' ]; then
  exit 0
fi

echo "apps/console is affected - running a production 'next build' smoke (RSC boundary guard, #537)..."
./tools/nx run @agent-lcars/console:build
