#!/usr/bin/env bash
# #813 centralizes LCARS worker failure writes in the hosted projector. Those
# workers leave MAINTAINER unset, so this script only annotates their log and
# never creates a second writer. Published-action consumers such as Sprinkles
# do not have LCARS's coupled agent-fallback-finalize workflow, however. They
# opt into the backward-compatible standalone path by supplying MAINTAINER,
# GH_TOKEN, and ISSUE_NUM; that path posts and parks the anchor directly.
set -euo pipefail

: "${AGENT:?AGENT is required}"
: "${SERVER_URL:?SERVER_URL is required}"
: "${REPO:?REPO is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${JOB_STATUS:?JOB_STATUS is required}"
MESSAGE_PREFIX="${MESSAGE_PREFIX:-}"
REASON="${REASON:-}"
MAINTAINER="${MAINTAINER:-}"

if [ "$JOB_STATUS" = "cancelled" ]; then
  MSG="was cancelled (likely hit the job's timeout-minutes limit)"
else
  MSG="failed"
fi

if [ -z "$MAINTAINER" ]; then
  echo "::notice::${MESSAGE_PREFIX}${AGENT} agent run $MSG: $SERVER_URL/$REPO/actions/runs/$RUN_ID$REASON -- the hosted finalizer's completion callback reports this on the anchor issue/PR (#813)."
  exit 0
fi

: "${GH_TOKEN:?GH_TOKEN is required when MAINTAINER enables standalone reporting}"
: "${ISSUE_NUM:?ISSUE_NUM is required when MAINTAINER enables standalone reporting}"

gh issue comment "$ISSUE_NUM" \
  --repo "$REPO" \
  --body "${MESSAGE_PREFIX}${AGENT} agent run $MSG: $SERVER_URL/$REPO/actions/runs/$RUN_ID$REASON"

# Keep the selected agent/status labels and every existing assignee intact.
# gh can occasionally exit non-zero after a successful mutation (#346), so
# verify the resulting issue state before treating that as a real failure.
mutate_or_verify() {
  local endpoint="$1" field_json="$2" jq_path="$3" value="$4" what="$5"
  if gh api "repos/$REPO/issues/$ISSUE_NUM/$endpoint" -f "$field_json" --silent; then
    return 0
  fi
  local issue_json
  if ! issue_json=$(gh api "repos/$REPO/issues/$ISSUE_NUM" 2>&1); then
    echo "::error::$what for #$ISSUE_NUM failed, and the verification re-read also failed: $issue_json"
    exit 1
  fi
  if ! jq -e --arg v "$value" "[$jq_path] | index(\$v) != null" <<<"$issue_json" >/dev/null; then
    echo "::error::$what for #$ISSUE_NUM failed and verification confirms it is absent."
    exit 1
  fi
  echo "::notice::gh api response-parse hiccup applying $what to #$ISSUE_NUM, but verification shows it landed (see #346)."
}

mutate_or_verify labels 'labels[]=status:needs-human' \
  '.labels[].name' 'status:needs-human' 'status:needs-human'

mutate_or_verify assignees "assignees[]=$MAINTAINER" \
  '.assignees[].login' "$MAINTAINER" "$MAINTAINER"
