#!/usr/bin/env bash
# #813: failure reporting is centralized in the hosted projector
# (apps/dispatch-broker/src/modules/projector.ts's projectWorkerFailure),
# driven by the hosted finalizer's own always-invoked completion callback
# (agent-fallback-finalize.yml calls the OIDC-authenticated
# /api/control-plane/completion endpoint for every worker result, success or
# not). That callback is the "existing hosted control-plane path" typed,
# authenticated evidence already flows through -- this script does not gain
# a parallel one of its own.
#
# This script therefore no longer writes an issue comment, status:needs-human,
# or a maintainer assignee directly: doing so from here, using this job's own
# token and this job's own untrusted-adjacent classification, is exactly the
# duplicated, uncoordinated write path #813 retired (the hosted finalizer
# independently re-derives the same outcome from GitHub's own job/step
# metadata and sends it through the ONE idempotent projector writer instead).
# It only annotates this run's own log, so a human reading this job's output
# can see the failure was recognized here, ahead of the authoritative report
# that lands via the hosted callback.
set -euo pipefail

: "${AGENT:?AGENT is required}"
: "${SERVER_URL:?SERVER_URL is required}"
: "${REPO:?REPO is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${JOB_STATUS:?JOB_STATUS is required}"
MESSAGE_PREFIX="${MESSAGE_PREFIX:-}"
REASON="${REASON:-}"

if [ "$JOB_STATUS" = "cancelled" ]; then
  MSG="was cancelled (likely hit the job's timeout-minutes limit)"
else
  MSG="failed"
fi

echo "::notice::${MESSAGE_PREFIX}${AGENT} agent run $MSG: $SERVER_URL/$REPO/actions/runs/$RUN_ID$REASON -- the hosted finalizer's completion callback reports this on the anchor issue/PR (#813)."
