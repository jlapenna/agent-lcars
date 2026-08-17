#!/usr/bin/env bash
# #813 centralized failure reporting in the hosted finalizer/orchestrator:
# agent-fallback-finalize.yml's completion callback drives the orchestrator
# (apps/console's /api/control-plane/completion route), which is the one
# writer of visible failure state on the anchor issue/PR. This script only
# annotates the failing run's own log so the failure is legible in place.
#
# It used to carry a standalone direct-park path (#4388: GH_TOKEN +
# ISSUE_NUM + MAINTAINER opted into posting the failure comment, adding
# status:needs-human, and assigning the maintainer directly). Every fleet
# consumer is a control-plane tenant whose lanes run the coupled
# agent-fallback-finalize.yml, so that path had become a second writer
# alongside the finalizer with no remaining standalone consumer; it was
# retired per maintainer decision 2026-08-17 and the finalizer/orchestrator
# now owns failure reporting outright.
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
