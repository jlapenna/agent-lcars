#!/usr/bin/env bash
# Builds the session-title CLI bundle and installs it to a stable,
# checkout-independent location, plus a `lcars` launcher on PATH.
#
# Why this exists (issue #1212): the declared-title command
# (`lcars session title "..."`, see the app README) needs a stable runnable
# name. A host with no launcher on PATH ships zero declared titles.
#
# This also has to NOT point anything at the checkout's own `dist/`: the
# primary checkout (`~/p/agent-lcars` on a host) is guardrail-reserved for
# a clean `main`, and `git clean -xfd` there erases build artifacts
# outright, so this script copies the built bundle OUT of the checkout into
# $LIB_DIR below, once, so the interactive `lcars` invocation never depends
# on the checkout's working tree afterward.
#
# Usage: from a checkout of this repo on the host (the primary
# ~/p/agent-lcars checkout that persists long-term, not a worktree meant to
# be torn down):
#   apps/telemetry-watcher/bin/install-session-title-cli.sh
#
# This is the development path: it installs whatever the checkout it runs
# from builds. Enrolled workstations do not use it. They receive the same
# bundles and launcher from the published archive
# (package-workstation-cli.sh, .github/workflows/publish-workstation-cli.yml),
# which homegit installs and refreshes; see docs/deployment-boundary.md.
# Homegit owns that copy and the ~/.local/bin/lcars link to it, so this
# script refuses to write over either: to try a checkout's build on such a
# host, install it beside the managed one with
# AGENT_LCARS_SESSION_TITLE_CLI_LIB_DIR and
# AGENT_LCARS_SESSION_TITLE_CLI_BIN_DIR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB_DIR="${AGENT_LCARS_SESSION_TITLE_CLI_LIB_DIR:-$HOME/.local/lib/agent-lcars}"
BIN_DIR="${AGENT_LCARS_SESSION_TITLE_CLI_BIN_DIR:-$HOME/.local/bin}"
BUNDLE_NAME=lcars-session-title.cjs
HOOK_NAME=lcars-hook.cjs
BUILT_HOOK="$REPO_ROOT/dist/apps/telemetry-watcher-hook/$HOOK_NAME"
# The hook flusher is its own bundle so `lcars hook` never loads Firestore;
# it must sit beside the CLI bundle, which spawns it from there.
FLUSHER_NAME=lcars-hook-flush.cjs
BUILT_FLUSHER="$REPO_ROOT/dist/apps/telemetry-watcher-hook-flush/$FLUSHER_NAME"
BUILT_BUNDLE="$REPO_ROOT/dist/apps/telemetry-watcher-session-title-cli/$BUNDLE_NAME"
# `lcars events agent` is its own bundle so other commands never load Pub/Sub.
EVENTS_NAME=lcars-events-agent.cjs
BUILT_EVENTS="$REPO_ROOT/dist/apps/telemetry-watcher-events-agent/$EVENTS_NAME"

# Homegit links $BIN_DIR/lcars to the published archive's launcher, and a
# write to that link lands in the archive. The archive also carries
# REVISION, which this install never writes. Either way the write would
# change files homegit manages, which its next apply reports as a conflict
# instead of repairing.
if [ -e "$LIB_DIR/REVISION" ] || [ -L "$BIN_DIR/lcars" ]; then
  echo "$LIB_DIR and $BIN_DIR/lcars hold the published workstation CLI that homegit manages. Set AGENT_LCARS_SESSION_TITLE_CLI_LIB_DIR and AGENT_LCARS_SESSION_TITLE_CLI_BIN_DIR to install this checkout's build somewhere else." >&2
  exit 1
fi

cd "$REPO_ROOT"
./tools/nx run-many -t session-title-cli hook-cli hook-flush-cli events-agent-cli -p @agent-lcars/telemetry-watcher

if [ ! -f "$BUILT_HOOK" ]; then
  echo "$BUILT_HOOK was not produced by the hook-cli build." >&2
  exit 1
fi
if [ ! -f "$BUILT_FLUSHER" ]; then
  echo "$BUILT_FLUSHER was not produced by the hook-flush-cli build." >&2
  exit 1
fi
if [ ! -f "$BUILT_EVENTS" ]; then
  echo "$BUILT_EVENTS was not produced by the events-agent-cli build." >&2
  exit 1
fi
if [ ! -f "$BUILT_BUNDLE" ]; then
  echo "$BUILT_BUNDLE was not produced by the session-title-cli build -- check apps/telemetry-watcher/project.json's outputPath/outputFileName for that target." >&2
  exit 1
fi

mkdir -p "$LIB_DIR" "$BIN_DIR"
install -m 0644 "$BUILT_BUNDLE" "$LIB_DIR/$BUNDLE_NAME"
install -m 0644 "$BUILT_HOOK" "$LIB_DIR/$HOOK_NAME"
install -m 0644 "$BUILT_FLUSHER" "$LIB_DIR/$FLUSHER_NAME"
install -m 0644 "$BUILT_EVENTS" "$LIB_DIR/$EVENTS_NAME"

# The launcher's shape, and why it resolves Node the way it does, live with
# its one definition in lcars-launcher.sh.
# shellcheck source=apps/telemetry-watcher/bin/lcars-launcher.sh
. "$SCRIPT_DIR/lcars-launcher.sh"
write_lcars_launcher "$BIN_DIR/lcars" "$LIB_DIR" \
  'apps/telemetry-watcher/bin/install-session-title-cli.sh -- re-run that script to update this file'

echo "Installed $LIB_DIR/$BUNDLE_NAME and launcher $BIN_DIR/lcars"
if ! command -v lcars >/dev/null 2>&1; then
  echo "$BIN_DIR is not on this shell's PATH -- add it (e.g. in your shell rc) for 'lcars session title' to work interactively. The systemd import timer invokes $BIN_DIR/lcars by its full path and does not need PATH." >&2
fi
