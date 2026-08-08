#!/usr/bin/env bash
# Claude-specific "Determine failure reason" signal, kept as an adapter-style
# input to the shared post-agent-gates.sh orchestrator rather than either
# forcing codex.yml/opencode.yml onto this version or dropping it (#645
# Phase 3). Only claude.yml points FAILURE_LOG_SCAN_SCRIPT at this file;
# codex.yml/opencode.yml leave it unset and get none of these extra
# signals, exactly as before this refactor.
#
# Greps this run's own just-completed agent-step log for two known crash
# signatures the shared NO_DELIVERABLE check cannot see on its own: a
# turn-budget exhaustion (real progress, not a crash) or an expired/invalid
# CLAUDE_CODE_OAUTH_TOKEN. Prints extra REASON text (already newline-
# prefixed, matching every other REASON value in this repo) to stdout, or
# nothing if neither signature matches. post-agent-gates.sh only invokes
# this when NO_DELIVERABLE was NOT set, mirroring the original elif
# ordering in claude.yml's "Determine failure reason" step.
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RUN_ID:?RUN_ID is required}"
AGENT_LABEL="${AGENT_LABEL:-}"
REDISPATCH_COMMAND="${REDISPATCH_COMMAND:-}"

LOG="$(gh run view "$RUN_ID" --log 2>/dev/null || true)"
# Same in-progress-run caveat the old inline step carried: this run's own
# log can legitimately be unavailable while the run is still in progress,
# so say so instead of letting the checks below silently find nothing.
if [ -z "$LOG" ]; then
  echo "::warning::Could not fetch this run's log (often unavailable while the run is still in progress); the turn-budget/OAuth-401 checks were skipped." >&2
  exit 0
fi

if echo "$LOG" | grep -qi "Reached maximum number of turns"; then
  printf '%s' $'\n\nRan out of its turn budget mid-task (`error_max_turns`) - not a crash, it may have made real progress. Check its last comment for a takeover/resume command. To retry with a fresh run, re-add the `'"$AGENT_LABEL"$'` label or reply `'"$REDISPATCH_COMMAND"$'`.'
  exit 0
fi

if (echo "$LOG" | grep -q '"api_error_status": 401' && echo "$LOG" | grep -q '"total_cost_usd": 0') || \
   (echo "$LOG" | grep -q '"is_error": true' && echo "$LOG" | grep -q '"total_cost_usd": 0'); then
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo 'readiness-failure=credential' >> "$GITHUB_OUTPUT"
  fi
  printf '%s' $'\n\nThe CLAUDE_CODE_OAUTH_TOKEN has expired or is invalid. To resolve this:\n1. Run `claude setup-token` on a browser-enabled terminal.\n2. Copy the token and update the `CLAUDE_CODE_OAUTH_TOKEN` secret in this repository.'
fi
