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
  MSG="was cancelled (likely hit the job's timeout-minutes limit)"
else
  MSG="failed"
fi
# Left strict (no verify-then-decide): unlike the label/assignee mutations
# below, "did this comment land" evidence is fuzzy - matching a comment back
# to this exact call means searching recent comments for one that mentions
# $RUN_ID, which can multi-match (retried runs, concurrent pipelines) or
# miss (gh's own paginated/`since` list has its own edge cases). Not worth
# it for #346: a genuine post failure here should still fail red.
gh issue comment "$ISSUE_NUM" \
  --repo "$REPO" \
  --body "${MESSAGE_PREFIX}${AGENT} agent run $MSG: $SERVER_URL/$REPO/actions/runs/$RUN_ID$REASON"

# Failure is a machine-authored parking path. Keep blocked state and
# the selected agent label intact while adding both durable human
# signals. The issue REST endpoints also work for PR anchors.
#
# gh occasionally exits non-zero on these `--silent` calls AFTER the
# mutation already landed - a response-body parse hiccup ("unexpected end
# of JSON input"), not an API failure (#346, seen twice in production:
# codex runs 30749363701 and 30759760688). Rather than fail an otherwise-
# successful park over a parse hiccup, verify-then-decide on failure: re-read
# the issue and only fail if the mutation is genuinely absent. A real
# permission/API failure still fails red, because the verification read then
# shows it missing too; if the verification read itself fails, that's
# inconclusive (not confirmed-present), so it also fails red.
#
# The JS-side equivalent of this same verify-then-decide pattern is
# apps/dispatch-broker/src/github-api.ts's ensureNeedsHumanParked -- look there
# before re-deriving it a third time.
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
