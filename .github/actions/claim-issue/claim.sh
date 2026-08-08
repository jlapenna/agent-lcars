#!/usr/bin/env bash
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${NUM:?NUM is required}"
: "${CLAIM_LOGIN:?CLAIM_LOGIN is required}"
: "${POST_PICKUP_COMMENT:?POST_PICKUP_COMMENT is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
AGENT="${AGENT:-}"
RUN_URL="${RUN_URL:-}"

pickup_comment_id=""

# `gh api -f 'assignees[]=...' --silent` can apply the mutation and then
# exit non-zero with "unexpected end of JSON input" because --silent hides
# the response body before gh's typed-field parser consumes it (#346; live
# canary run 31261284910 reproduced this in claim-issue). Send an explicit
# JSON request body and redirect the successfully parsed response instead.
if jq -cn --arg login "$CLAIM_LOGIN" '{assignees: [$login]}' |
  gh api "repos/$REPO/issues/$NUM/assignees" \
    --method POST --input - >/dev/null; then
  echo "claimed=true" >> "$GITHUB_OUTPUT"
  if [ "$POST_PICKUP_COMMENT" = "true" ]; then
    pickup_comment_id=$(gh api "repos/$REPO/issues/$NUM/comments" \
      -f "body=🤖 $AGENT agent run started — working on this issue: $RUN_URL" \
      --jq '.id' 2>/dev/null || true)
    if [ -z "$pickup_comment_id" ]; then
      echo "::warning::Could not post $AGENT pickup comment on #$NUM"
    fi
  fi
else
  echo "claimed=false" >> "$GITHUB_OUTPUT"
  echo "::warning::Could not assign $CLAIM_LOGIN to #$NUM"
fi
echo "pickup-comment-id=$pickup_comment_id" >> "$GITHUB_OUTPUT"
