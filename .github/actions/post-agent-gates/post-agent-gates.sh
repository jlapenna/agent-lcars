#!/usr/bin/env bash
# Shared post-agent gate orchestrator (#645 Phase 3). claude.yml/codex.yml/
# opencode.yml used to hand-copy four separate steps after their agent step
# (Finalize telemetry sidecar, Verify a deliverable exists, Determine
# failure reason, Report failure on the issue). This script is the single
# entry point that replaces all four; each worker now has ONE post-agent
# `run: bash "$RUNNER_TEMP/trusted-actions/post-agent-gates/
# post-agent-gates.sh"` step instead. That invocation form is load-bearing,
# not a style choice -- see snapshot-enforcement-scripts/action.yml: the
# agent step immediately before this one has unrestricted Bash on the
# working tree, so every gate must run from the pre-agent snapshot via
# `run:`, never `uses:`.
#
# Because the four sub-gates now run inside one step, this script
# reproduces each one's original `if:` condition itself instead of relying
# on GitHub Actions to skip steps:
#   - telemetry-finalize: always runs; its own failure is swallowed (was
#     `if: always()` + `continue-on-error: true` on its own step).
#   - verify-deliverable: only when JOB_STATUS is "success" (was
#     `if: success()`) -- JOB_STATUS is captured by the caller as
#     `${{ job.status }}` at step-config time, i.e. reflecting every step
#     that ran before this one, including a lane-specific gate positioned
#     between the agent step and this one (e.g. claude.yml's own separate,
#     unmerged "Verify Claude run status" step) -- if that already failed
#     the job, JOB_STATUS is "failure" here and verify-deliverable is
#     correctly skipped, exactly as it would have been skipped before.
#   - failure-reason + report-failure: only once the job is known to be
#     failing -- either JOB_STATUS was not "success" to begin with, or
#     verify-deliverable just failed (was `if: failure() || cancelled()`,
#     which becomes true the instant an `if: success()`-gated step upstream
#     fails).
#
# This script's own exit status reproduces "Verify a deliverable exists"
# being the step that fails the job: non-zero exactly when verify-
# deliverable failed (while JOB_STATUS was "success"), or when
# report-failure itself failed to land. When JOB_STATUS was already
# failure/cancelled coming in, this step exits 0 as long as report-failure
# succeeds -- exactly like the original "Report failure on the issue" step,
# which could itself succeed even though the job was already red from an
# earlier, real failure.
#
# Driven entirely by environment variables:
#   Always required: GH_TOKEN, AGENT, REPO, SERVER_URL, RUN_ID, ISSUE,
#     JOB_STATUS, MAINTAINER.
#   Required only when JOB_STATUS is "success" (verify-deliverable's own
#     inputs at that point, #815): MODE, ATTEMPT_ID.
#   Optional: WRITER_CREDENTIALS_FILE (telemetry-finalize's own credential
#     path; empty is valid, matching telemetry-start being best-effort);
#     NO_DELIVERABLE_REASON (each lane's own no-deliverable wording,
#     pre-rendered by the caller with its own AGENT_LABEL/REDISPATCH_COMMAND
#     via `${{ env.* }}` substitution in the workflow YAML -- an
#     adapter-style input, not computed here); FAILURE_LOG_SCAN_SCRIPT
#     (path to an optional lane-provided script that inspects this run's
#     structured runtime result for supplementary failure signals --
#     claude.yml only, see claude-log-scan.sh; codex.yml/opencode.yml leave
#     this unset and get none of claude's extra signals, exactly as before).
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${AGENT:?AGENT is required}"
: "${REPO:?REPO is required}"
: "${SERVER_URL:?SERVER_URL is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${ISSUE:?ISSUE is required}"
: "${JOB_STATUS:?JOB_STATUS is required}"
: "${MAINTAINER:?MAINTAINER is required}"
WRITER_CREDENTIALS_FILE="${WRITER_CREDENTIALS_FILE:-}"
NO_DELIVERABLE_REASON="${NO_DELIVERABLE_REASON:-}"
FAILURE_LOG_SCAN_SCRIPT="${FAILURE_LOG_SCAN_SCRIPT:-}"
AGENT_STEP_OUTCOME="${AGENT_STEP_OUTCOME:-}"
READINESS_FAILURE="${READINESS_FAILURE:-}"

case "$READINESS_FAILURE" in
  ''|credential|provider|bootstrap) ;;
  *)
    echo "::error::Invalid READINESS_FAILURE: $READINESS_FAILURE"
    exit 1
    ;;
esac

# The worker job publishes this step output to its independent hosted
# fallback finalizer. Write it only after either the clean success path needs
# no report or the primary failure report actually landed. Missing/false means
# the hosted job must take over; this also covers checkout/snapshot failure,
# where this trusted script never existed on the self-hosted runner at all.
mark_post_agent_gates_complete() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo 'complete=true' >> "$GITHUB_OUTPUT"
  fi
}

publish_outcome_kind() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "outcome-kind=$1" >> "$GITHUB_OUTPUT"
  fi
}

if [ -n "$READINESS_FAILURE" ] && [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "readiness-failure=$READINESS_FAILURE" >> "$GITHUB_OUTPUT"
fi

trusted_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Finalize telemetry sidecar: was if: always(), continue-on-error: true -
WRITER_CREDENTIALS_FILE="$WRITER_CREDENTIALS_FILE" RUN_ID="$RUN_ID" NUM="$ISSUE" \
  bash "$trusted_dir/telemetry-finalize/telemetry-finalize.sh" || true

# --- Verify a deliverable exists: was if: success() -------------------------
deliverable_failed=0
no_deliverable=0
if [ "$JOB_STATUS" = "success" ]; then
  : "${MODE:?MODE is required when JOB_STATUS is success}"
  : "${ATTEMPT_ID:?ATTEMPT_ID is required when JOB_STATUS is success}"
  if ! NUM="$ISSUE" bash "$trusted_dir/verify-deliverable/verify-deliverable.sh"; then
    deliverable_failed=1
    if [ -n "${GITHUB_ENV:-}" ] && [ -f "$GITHUB_ENV" ] && \
      grep -qx 'NO_DELIVERABLE=1' "$GITHUB_ENV"; then
      no_deliverable=1
    fi
  fi
fi

if [ "$JOB_STATUS" = "success" ] && [ "$deliverable_failed" -eq 0 ]; then
  # Nothing failed and nothing needs reporting -- mirrors the original
  # "Determine failure reason"/"Report failure on the issue" steps both
  # being skipped by their own if: failure() || cancelled().
  if ! grep -q '^outcome-kind=' "${GITHUB_OUTPUT:-/dev/null}" 2>/dev/null; then
    publish_outcome_kind unknown-success
  fi
  mark_post_agent_gates_complete
  exit 0
fi

# --- Classify and determine failure reason: was if: failure() || cancelled() -
if [ "$no_deliverable" -eq 1 ] || [ "$JOB_STATUS" = "success" ]; then
  publish_outcome_kind outcome-gate-failure
elif [ -z "$AGENT_STEP_OUTCOME" ] || [ "$AGENT_STEP_OUTCOME" = "skipped" ]; then
  publish_outcome_kind startup-failure
else
  publish_outcome_kind trajectory-failure
fi

reason=""
if [ "$no_deliverable" -eq 1 ]; then
  reason=$'\n\n'"$NO_DELIVERABLE_REASON"
elif [ -n "$FAILURE_LOG_SCAN_SCRIPT" ] && [ -f "$FAILURE_LOG_SCAN_SCRIPT" ]; then
  reason="$(GH_TOKEN="$GH_TOKEN" RUN_ID="$RUN_ID" bash "$FAILURE_LOG_SCAN_SCRIPT")"
fi

# --- Report failure on the issue: was if: failure() || cancelled() ---------
GH_TOKEN="$GH_TOKEN" AGENT="$AGENT" REPO="$REPO" SERVER_URL="$SERVER_URL" \
  RUN_ID="$RUN_ID" ISSUE_NUM="$ISSUE" REASON="$reason" JOB_STATUS="$JOB_STATUS" \
  MAINTAINER="$MAINTAINER" \
  bash "$trusted_dir/report-failure/report-failure.sh"
report_status=$?

if [ "$report_status" -eq 0 ]; then
  mark_post_agent_gates_complete
fi

if [ "$deliverable_failed" -eq 1 ] || [ "$report_status" -ne 0 ]; then
  exit 1
fi
exit 0
