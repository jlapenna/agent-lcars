#!/usr/bin/env bash
# Same gate every worker uses (agent-protocol.md #5): an agent can reason to
# a genuine conclusion and stop without ever posting it, so a bare "success"
# job conclusion is never trusted on its own. A run passes if ANY of four
# deliverable kinds exists:
#   (a) an open/updated PR referencing #NUM, created or updated since
#       STARTED_AT (covers new PRs AND pushes to existing ones; on an
#       implement dispatch, EXCLUDE_PR_AUTHOR keeps a concurrently
#       dispatched sibling pipeline's PR from satisfying this clause, but
#       that exclusion is skipped on a reply dispatch - see clause (a)
#       below for why);
#   (b) the issue was closed since STARTED_AT;
#   (c) the status:needs-human label is present (the sanctioned blocked/
#       clarifying-question ending); or
#   (d) - only on a reply dispatch (MODE=reply) - EXPECTED_COMMENT_LOGIN
#       posted a comment on the anchor since STARTED_AT. Gated on reply
#       mode deliberately: a bare pickup/plan comment alone proves nothing
#       on an implement dispatch, but a reply's whole sanctioned
#       deliverable can legitimately BE a comment.
#
# Uses the REST list/view endpoints throughout (not `gh pr list`/`gh issue
# view --json ... | GraphQL-backed flags) - see docs/bot-identity-formats.md:
# REST shape is canonical in this repo, and mixing REST- and GraphQL-shaped
# logins without translating is what silently broke #175.
#
# A FAILED lookup is never silently treated as "no deliverable found": each
# clause's `gh` call is captured without swallowing its exit status, and any
# failure is collected and reported as a distinct, named error instead of
# falling through to the generic "no deliverable" message.
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${AGENT:?AGENT is required}"
: "${REPO:?REPO is required}"
: "${NUM:?NUM is required}"
: "${STARTED_AT:?STARTED_AT is required}"
: "${MODE:?MODE is required}"
: "${EXPECTED_COMMENT_LOGIN:?EXPECTED_COMMENT_LOGIN is required}"
EXCLUDE_PR_AUTHOR="${EXCLUDE_PR_AUTHOR:-}"
EXCLUDE_COMMENT_ID="${EXCLUDE_COMMENT_ID:-}"

found=""
errors=()

# (a) PR referencing #NUM created/updated since STARTED_AT. The
# `#$NUM([^0-9]|$)` boundary is load-bearing: an unanchored substring match
# on "#4" also hits "#42"/"#400" in any PR title/body. sort=updated,
# direction=desc so a push to an OLDER existing PR isn't missed once >50 PRs
# exist (creation-date order would drop it off the first page).
# EXCLUDE_PR_AUTHOR guards against crediting a different, concurrently
# dispatched sibling pipeline's PR when two agents are testing against the
# same issue - each workflow passes the OTHER pipelines' bot login here,
# never its own. Only applied on an implement dispatch, though: on a reply
# dispatch the anchor (issue or PR) is explicit and dispatched deliberately
# at that anchor, so an update to a PR referencing it is valid evidence
# regardless of which pipeline authored the PR - excluding by author there
# would discard a legitimate cross-agent takeover (e.g. this run is a
# @claude reply continuing a PR codex originally opened).
if [ -z "$found" ]; then
  if pr_json=$(gh api "repos/$REPO/pulls?state=all&sort=updated&direction=desc&per_page=50" 2>&1); then
    prs=$(jq -r \
      --arg started "$STARTED_AT" --arg num "$NUM" --arg exclude "$EXCLUDE_PR_AUTHOR" --arg mode "$MODE" \
      '[.[] | select(.updated_at >= $started)
             | select($mode == "reply" or $exclude == "" or .user.login != $exclude)
             | select((.title + " " + (.body // "")) | test("#" + $num + "([^0-9]|$)"))]
       | length' <<<"$pr_json")
    if [ "${prs:-0}" -gt 0 ]; then
      found="PR referencing #$NUM created/updated since $STARTED_AT"
    fi
  else
    errors+=("PR list lookup (gh api repos/$REPO/pulls) failed: $pr_json")
  fi
fi

# (b)+(c) share one REST issue fetch (state/closed_at/labels all come back
# on the same object): (b) issue closed since STARTED_AT - closed_at, not
# just current state=="closed", because a pre-existing closure (e.g.
# another pipeline closed it moments before this run started) must not
# count as THIS run's deliverable; (c) status:needs-human label present
# (the sanctioned blocked/clarifying-question ending).
if [ -z "$found" ]; then
  if issue_json=$(gh api "repos/$REPO/issues/$NUM" 2>&1); then
    closed_at=$(jq -r 'if .state == "closed" then (.closed_at // "") else "" end' <<<"$issue_json")
    if [ -n "$closed_at" ] && [ "$closed_at" \> "$STARTED_AT" ]; then
      found="issue #$NUM closed at $closed_at (after $STARTED_AT)"
    fi
    if [ -z "$found" ]; then
      labeled=$(jq -r '[.labels[].name] | contains(["status:needs-human"])' <<<"$issue_json")
      if [ "$labeled" = "true" ]; then
        found="status:needs-human label applied on #$NUM"
      fi
    fi
  else
    errors+=("Issue lookup (gh api repos/$REPO/issues/$NUM) failed: $issue_json")
  fi
fi

# (d) reply-mode comment evidence. EXCLUDE_COMMENT_ID skips a scripted
# pickup comment (if this pipeline posts one): GitHub's `since` filter uses
# updated_at, so a pickup comment the agent itself edits during the run
# would otherwise look like fresh evidence.
if [ -z "$found" ] && [ "$MODE" = "reply" ]; then
  if comments_json=$(gh api "repos/$REPO/issues/$NUM/comments?since=$STARTED_AT&per_page=100" 2>&1); then
    botcomments=$(jq -r \
      --arg login "$EXPECTED_COMMENT_LOGIN" --arg exclude "$EXCLUDE_COMMENT_ID" \
      '[.[] | select(.user.login == $login) | select($exclude == "" or (.id | tostring) != $exclude)]
       | length' <<<"$comments_json")
    if [ "${botcomments:-0}" -ge 1 ]; then
      found="$EXPECTED_COMMENT_LOGIN posted a comment on #$NUM since $STARTED_AT"
    fi
  else
    errors+=("Comment lookup (gh api repos/$REPO/issues/$NUM/comments) failed: $comments_json")
  fi
fi

if [ -n "$found" ]; then
  echo "Deliverable evidence: $found"
  exit 0
fi

if [ "${#errors[@]}" -gt 0 ]; then
  joined=$(printf '%s | ' "${errors[@]}")
  echo "::error::$AGENT deliverable check could not complete - this is a FAILED lookup, distinct from 'no deliverable found': ${joined%' | '}"
  exit 1
fi

echo "NO_DELIVERABLE=1" >> "${GITHUB_ENV:-/dev/null}"
reply_clause=""
if [ "$MODE" = "reply" ]; then
  reply_clause=", no qualifying comment posted"
fi
echo "::error::$AGENT run completed 'successfully' but produced no deliverable on #$NUM (no PR referencing #$NUM created/updated since $STARTED_AT, issue not closed, no status:needs-human label${reply_clause}). All of its local work may be lost."
exit 1
