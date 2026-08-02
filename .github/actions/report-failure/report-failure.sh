#!/usr/bin/env bash
# Failed agent runs were previously silent - no comment, no PR, nothing on
# the issue. Surface them where the work was requested. The caller's
# `if: failure() || cancelled()` is load-bearing (MUST cover cancelled():
# a timeout-minutes kill sets conclusion `cancelled`, not `failure`).
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${AGENT:?AGENT is required}"
: "${REPO:?REPO is required}"
: "${SERVER_URL:?SERVER_URL is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${ISSUE_NUM:?ISSUE_NUM is required}"
: "${JOB_STATUS:?JOB_STATUS is required}"
: "${MAINTAINER:?MAINTAINER is required}"
MESSAGE_PREFIX="${MESSAGE_PREFIX:-}"
REASON="${REASON:-}"

if [ "$JOB_STATUS" = "cancelled" ]; then
  MSG="was cancelled (likely hit the 90-minute job timeout)"
else
  MSG="failed"
fi
gh issue comment "$ISSUE_NUM" \
  --repo "$REPO" \
  --body "${MESSAGE_PREFIX}${AGENT} agent run $MSG: $SERVER_URL/$REPO/actions/runs/$RUN_ID$REASON"
# Failure is a machine-authored parking path. Keep blocked state and
# the selected agent label intact while adding both durable human
# signals. The issue REST endpoints also work for PR anchors.
gh api "repos/$REPO/issues/$ISSUE_NUM/labels" \
  -f 'labels[]=status:needs-human' --silent
gh api "repos/$REPO/issues/$ISSUE_NUM/assignees" \
  -f "assignees[]=$MAINTAINER" --silent
