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
# This step publishes nothing: the independent hosted fallback finalizer
# (agent-fallback-finalize.yml) deliberately re-derives lifecycle evidence
# from GitHub's job metadata and exact attempt markers rather than trusting
# any worker-side step output, and report-failure.sh is log-only -- the
# finalizer's completion callback drives the orchestrator, the one writer
# of visible failure state (#813; the direct-park path was retired per
# maintainer decision 2026-08-17).
#
# Driven entirely by environment variables:
#   Always required: GH_TOKEN, AGENT, REPO, SERVER_URL, RUN_ID, JOB_STATUS.
#   Required only when JOB_STATUS is "success" (verify-deliverable's own
#     inputs at that point, #815): MODE and ATTEMPT_ID, both mandatory.
#     verify-deliverable.sh is exact-marker-only now -- the legacy
#     time-window/login inference pair (STARTED_AT +
#     EXPECTED_COMMENT_LOGIN, #1208 Phase 2/#1237's optionality) was
#     deleted once every fleet consumer passed ATTEMPT_ID (agent-lcars's
#     own three lanes, homelab#697, sprinkles' exact-marker flip), so this
#     script no longer reads or forwards either variable.
#   Optional: ISSUE (empty for a native work-anchored run -- forwarded
#     unchanged to telemetry-finalize.sh, which is already anchor-agnostic);
#     NATIVE_WORK (set only from the trusted reusable-workflow input, never
#     inherited from $GITHUB_ENV): native Work terminal outcomes are verified
#     by the hosted finalizer after this worker job is closed.  That finalizer
#     can read this exact worker-job log and bind its structured outcome to the
#     broker dispatch; this still-running worker cannot safely do either.
#     WRITER_CREDENTIALS_FILE (telemetry-finalize's own credential
#     path; empty is valid, matching telemetry-start being best-effort);
#     NO_DELIVERABLE_REASON (each lane's own no-deliverable wording,
#     pre-rendered by the caller with its own AGENT_LABEL/REDISPATCH_COMMAND
#     via `${{ env.* }}` substitution in the workflow YAML -- an
#     adapter-style input, not computed here); FAILURE_LOG_SCAN_SCRIPT
#     (path to an optional lane-provided script that inspects this run's
#     structured runtime result for supplementary failure signals --
#     claude.yml only, see claude-log-scan.sh; codex.yml/opencode.yml leave
#     this unset and get none of claude's extra signals, exactly as before);
#     INTENT_ID (the orchestrator run id, `broker_intent_id` -- the join key
#     a work item needs to find its sessions; forwarded unchanged to
#     telemetry-finalize.sh, which forwards it unchanged to
#     sidecar-lifecycle.sh; empty is valid).
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${AGENT:?AGENT is required}"
: "${REPO:?REPO is required}"
: "${SERVER_URL:?SERVER_URL is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${JOB_STATUS:?JOB_STATUS is required}"
ISSUE="${ISSUE:-}"
WRITER_CREDENTIALS_FILE="${WRITER_CREDENTIALS_FILE:-}"
NO_DELIVERABLE_REASON="${NO_DELIVERABLE_REASON:-}"
FAILURE_LOG_SCAN_SCRIPT="${FAILURE_LOG_SCAN_SCRIPT:-}"
INTENT_ID="${INTENT_ID:-}"
NATIVE_WORK="${NATIVE_WORK:-}"

trusted_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Finalize telemetry sidecar: was if: always(), continue-on-error: true -
# telemetry-finalize is Coupled (baked-in sidecar-lifecycle.sh, see
# docs/published-actions.md), so a standalone consumer that snapshots this
# script without it is expected, not an error -- skip cleanly rather than
# letting the "|| true" below merely swallow a raw "No such file or
# directory" from bash itself.
if [ -f "$trusted_dir/telemetry-finalize/telemetry-finalize.sh" ]; then
  WRITER_CREDENTIALS_FILE="$WRITER_CREDENTIALS_FILE" RUN_ID="$RUN_ID" NUM="$ISSUE" \
    INTENT_ID="$INTENT_ID" \
    bash "$trusted_dir/telemetry-finalize/telemetry-finalize.sh" || true
else
  echo "::notice::telemetry-finalize not snapshotted; skipping (standalone consumer without the coupled runner image)."
fi

# --- Verify a deliverable exists: was if: success() -------------------------
deliverable_failed=0
no_deliverable=0
if [ "$JOB_STATUS" = "success" ]; then
  : "${MODE:?MODE is required when JOB_STATUS is success}"
  # Exact-marker only: verify-deliverable.sh requires ATTEMPT_ID
  # unconditionally now that the legacy time-window/login inference mode
  # is deleted. Fail here, before invoking it, with the same named
  # diagnostic shape as MODE above.
  : "${ATTEMPT_ID:?ATTEMPT_ID is required when JOB_STATUS is success - the deliverable gate is exact-marker-only and the legacy STARTED_AT/EXPECTED_COMMENT_LOGIN inference mode was deleted}"
  if [ "$NATIVE_WORK" = '1' ]; then
    # A work anchor has no GitHub issue thread.  Do not weaken the normal
    # exact-marker gate into "job succeeded": the independent hosted
    # finalizer reads this closed worker job and accepts only a structured
    # native park/no-op marker paired with this attempt marker.  A silent
    # native success remains an outcome-gate failure there.
    echo "::notice::Native Work terminal outcome deferred to the hosted finalizer."
  else
    if ! NUM="$ISSUE" bash "$trusted_dir/verify-deliverable/verify-deliverable.sh"; then
      deliverable_failed=1
      if [ -n "${GITHUB_ENV:-}" ] && [ -f "$GITHUB_ENV" ] && \
        grep -qx 'NO_DELIVERABLE=1' "$GITHUB_ENV"; then
        no_deliverable=1
      fi
    fi
  fi
fi

if [ "$JOB_STATUS" = "success" ] && [ "$deliverable_failed" -eq 0 ]; then
  # Nothing failed and nothing needs reporting -- mirrors the original
  # "Determine failure reason"/"Report failure on the issue" steps both
  # being skipped by their own if: failure() || cancelled().
  exit 0
fi

# --- Determine failure reason: was if: failure() || cancelled() -------------
reason=""
if [ "$no_deliverable" -eq 1 ]; then
  reason=$'\n\n'"$NO_DELIVERABLE_REASON"
elif [ -n "$FAILURE_LOG_SCAN_SCRIPT" ] && [ -f "$FAILURE_LOG_SCAN_SCRIPT" ]; then
  reason="$(GH_TOKEN="$GH_TOKEN" RUN_ID="$RUN_ID" bash "$FAILURE_LOG_SCAN_SCRIPT")"
fi

# --- Report failure on the issue: was if: failure() || cancelled() ---------
# report-failure.sh is log-only (#813): it annotates this run's own log,
# and the hosted finalizer's completion callback reports the failure on
# the anchor issue/PR through the orchestrator, the one writer. Its former
# standalone direct-park mode was retired per maintainer decision
# 2026-08-17, so no GitHub-write credentials are forwarded here.
AGENT="$AGENT" REPO="$REPO" SERVER_URL="$SERVER_URL" \
  RUN_ID="$RUN_ID" REASON="$reason" JOB_STATUS="$JOB_STATUS" \
  bash "$trusted_dir/report-failure/report-failure.sh"
report_status=$?

if [ "$deliverable_failed" -eq 1 ] || [ "$report_status" -ne 0 ]; then
  exit 1
fi
exit 0
