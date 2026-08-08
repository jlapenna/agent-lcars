#!/usr/bin/env bash
# Claude-specific "Determine failure reason" signal, kept as an adapter-style
# input to the shared post-agent-gates.sh orchestrator rather than either
# forcing codex.yml/opencode.yml onto this version or dropping it (#645
# Phase 3). Only claude.yml points FAILURE_LOG_SCAN_SCRIPT at this file;
# codex.yml/opencode.yml leave it unset and get none of these extra
# signals, exactly as before this refactor.
#
# Greps Claude Code Action's structured execution file for runtime signatures
# the shared NO_DELIVERABLE check cannot see on its own: turn-budget
# exhaustion, a positive OAuth 401, or a zero-cost provider-initialization
# failure. The action writes this file before its step exits, so it remains
# available while the workflow's own in-progress run log often is not. The
# run log is retained only as a compatibility fallback for a missing
# execution-file output. Prints extra REASON text (already newline-
# prefixed, matching every other REASON value in this repo) to stdout, or
# nothing if neither signature matches. post-agent-gates.sh only invokes this
# when NO_DELIVERABLE was NOT set, mirroring the original elif ordering in
# claude.yml's "Determine failure reason" step.
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RUN_ID:?RUN_ID is required}"
AGENT_LABEL="${AGENT_LABEL:-}"
REDISPATCH_COMMAND="${REDISPATCH_COMMAND:-}"
CLAUDE_EXECUTION_FILE="${CLAUDE_EXECUTION_FILE:-}"

LOG=""
if [ -n "$CLAUDE_EXECUTION_FILE" ]; then
  if [ -r "$CLAUDE_EXECUTION_FILE" ]; then
    LOG="$(cat "$CLAUDE_EXECUTION_FILE")"
  else
    echo "::warning::Claude execution file '$CLAUDE_EXECUTION_FILE' is unavailable;" \
      "falling back to the in-progress run log." >&2
  fi
fi
if [ -z "$LOG" ]; then
  LOG="$(gh run view "$RUN_ID" --log 2>/dev/null || true)"
fi
# A consumer on an older claude-code-action may expose neither source. Make
# that visible instead of letting the checks below silently find nothing.
if [ -z "$LOG" ]; then
  echo "::warning::Neither Claude's execution file nor this in-progress run's" \
    "log was available; the turn-budget/readiness checks were skipped." >&2
  exit 0
fi

if echo "$LOG" | grep -Eqi 'Reached maximum number of turns|"subtype"[[:space:]]*:[[:space:]]*"error_max_turns"'; then
  printf '%s' $'\n\nRan out of its turn budget mid-task (`error_max_turns`) - not a crash, it may have made real progress. Check its last comment for a takeover/resume command. To retry with a fresh run, re-add the `'"$AGENT_LABEL"$'` label or reply `'"$REDISPATCH_COMMAND"$'`.'
  exit 0
fi

if echo "$LOG" | grep -q '"api_error_status": 401' && echo "$LOG" | grep -q '"total_cost_usd": 0'; then
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo 'readiness-failure=credential' >> "$GITHUB_OUTPUT"
  fi
  printf '%s' $'\n\nThe CLAUDE_CODE_OAUTH_TOKEN has expired or is invalid. To resolve this:\n1. Run `claude setup-token` on a browser-enabled terminal.\n2. Copy the token and update the `CLAUDE_CODE_OAUTH_TOKEN` secret in this repository.'
  exit 0
fi

if echo "$LOG" | grep -q '"is_error": true' && echo "$LOG" | grep -q '"total_cost_usd": 0'; then
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo 'readiness-failure=provider' >> "$GITHUB_OUTPUT"
  fi
  printf '%s' $'\n\nClaude Code failed during provider initialization before any billed work (`is_error:true`, zero cost). Its structured result did not identify an OAuth 401, so this is classified as provider readiness rather than a credential rotation. Inspect the Claude step and provider health before retrying.'
fi
