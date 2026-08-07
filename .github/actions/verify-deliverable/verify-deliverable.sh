#!/usr/bin/env bash
# Same gate every worker uses (agent-protocol.md #5): an agent can reason to
# a genuine conclusion and stop without ever posting it, so a bare "success"
# job conclusion is never trusted on its own.
#
# A run passes if EITHER an exact attempt-claim marker is found (clause 0,
# #645 Phase 4) OR any of five inference-based deliverable kinds exists
# (clauses (a)-(e), unchanged):
#   (0) an artifact (PR, comment, or - on a review dispatch - a pull request
#       review) whose body carries THIS run's own hidden
#       `<!-- attempt-claim:<attempt-id> -->` marker (see
#       libs/dispatch-contracts/src/marker.ts's formatClaimMarker and
#       agent-protocol.md #5). This is exact evidence: the marker names one
#       specific attempt, so a marker for a different attempt - or no marker
#       at all - does not satisfy it. Evaluated FIRST and does not use
#       STARTED_AT or any bot-login exclusion, because the marker itself is
#       the identity check clauses (a)-(e) can only approximate with a time
#       window plus a shared bot login (codex and opencode both push as
#       agent-lcars[bot] - see clause (a)'s own comment below). Additive: an
#       agent that is not yet stamping the marker (#645 says the inference
#       path below is only removed after soak) simply falls through to
#       clauses (a)-(e) exactly as before;
#   (a) an open/updated PR referencing #NUM, created or updated since
#       STARTED_AT (covers new PRs AND pushes to existing ones; on an
#       implement dispatch, EXCLUDE_PR_AUTHOR keeps a concurrently
#       dispatched sibling pipeline's PR from satisfying this clause, but
#       that exclusion is skipped on a reply dispatch - see clause (a)
#       below for why). Also matches when #NUM IS the PR's own number, not
#       just a title/body reference to it - an agent:*-on-PR takeover
#       dispatch (#567) has the anchor and the pushed-to PR be the exact
#       same object, which never mentions its own number in its own title
#       or body;
#   (b) the issue was closed since STARTED_AT;
#   (c) the status:needs-human label is present (the sanctioned blocked/
#       clarifying-question ending);
#   (d) - only on a reply dispatch (MODE=reply) or a runbook dispatch
#       (RUNBOOK non-empty) - EXPECTED_COMMENT_LOGIN posted a comment on
#       the anchor since STARTED_AT. Gated deliberately: a bare pickup/plan
#       comment alone proves nothing on an ordinary implement dispatch, but
#       a reply's - or a runbook's - whole sanctioned deliverable can
#       legitimately BE a comment (e.g. an unstick-prs summary); or
#   (e) - only on a review dispatch (MODE=review) - EXPECTED_COMMENT_LOGIN
#       submitted a pull request review on #NUM since STARTED_AT. A review
#       dispatch's anchor is always a pull request and its whole sanctioned
#       deliverable IS the review verdict, which GitHub records as a
#       `/pulls/{n}/reviews` object, not an issue comment - clause (d)'s
#       comments endpoint would never see it.
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
RUNBOOK="${RUNBOOK:-}"
EXCLUDE_PR_AUTHOR="${EXCLUDE_PR_AUTHOR:-}"
EXCLUDE_COMMENT_ID="${EXCLUDE_COMMENT_ID:-}"
# Optional, not required: dispatch-broker/action.yml's "Publish attempt
# identity" step exports this to every later step of every worker job
# (#645 Phase 3/4), but a hand-triggered workflow_dispatch predating that
# rollout has none - clause 0 below just no-ops when it is empty, exactly
# like an agent that has not started stamping the marker yet.
ATTEMPT_ID="${ATTEMPT_ID:-}"

found=""
found_via=""
errors=()

# (0) Exact attempt-claim marker - see header comment above.
#
# Every lookup here paginates. Unlike clause (a), which is a deliberately
# recency-scoped query, these have no sort and no time filter -- the marker
# IS the identity check - so "the first page" is an arbitrary slice, and a
# marker one page deep would read as a genuine absence.
#
# A lookup failure here falls through to clauses (a)-(e) rather than being
# recorded, BUT only where one of them actually repeats the same lookup.
# That holds for PRs (clause (a) always runs) and for reviews (clause (e)
# is gated on MODE=review, exactly as the review lookup below is). It does
# NOT hold for comments: clause (d) only runs for reply mode or a runbook
# dispatch, so in implement mode nothing re-queries them, and a transient
# failure would silently become NO_DELIVERABLE=1 -- an inconclusive lookup
# misreported as a confirmed absence. That one case is recorded here.
if [ -n "$ATTEMPT_ID" ]; then
  claim_marker="<!-- attempt-claim:${ATTEMPT_ID} -->"

  # PRs: any PR (regardless of author or update time - the marker itself is
  # the identity check) whose title or body carries this exact marker.
  if claim_pr_hits=$(gh api "repos/$REPO/pulls?state=all&per_page=100" --paginate \
    --jq ".[] | select(((.title // \"\") + \"\\n\" + (.body // \"\")) | contains(\"$claim_marker\")) | .number" 2>&1); then
    if [ -n "$claim_pr_hits" ]; then
      found="PR carrying this run's attempt-claim marker ($ATTEMPT_ID)"
      found_via="exact"
    fi
  fi

  # Comments: not gated on MODE the way clause (d) is - a marker stamped on
  # a comment is exact evidence regardless of dispatch mode.
  if [ -z "$found" ]; then
    if claim_comment_hits=$(gh api "repos/$REPO/issues/$NUM/comments?per_page=100" --paginate \
      --jq ".[] | select((.body // \"\") | contains(\"$claim_marker\")) | .id" 2>&1); then
      if [ -n "$claim_comment_hits" ]; then
        found="comment carrying this run's attempt-claim marker ($ATTEMPT_ID)"
        found_via="exact"
      fi
    elif [ "$MODE" != "reply" ] && [ -z "$RUNBOOK" ]; then
      # Clause (d) will not run for this dispatch, so nothing else repeats
      # this lookup: record the failure rather than letting an inconclusive
      # result be reported as a confirmed absence.
      errors+=("Attempt-claim comment lookup (gh api repos/$REPO/issues/$NUM/comments) failed: $claim_comment_hits")
    fi
  fi

  # Reviews: gated on MODE=review, same as clause (e) - `pulls/$NUM/reviews`
  # 404s when #NUM is not a pull request, and review mode is the one case
  # this script already knows #NUM is one.
  if [ -z "$found" ] && [ "$MODE" = "review" ]; then
    if claim_review_hits=$(gh api "repos/$REPO/pulls/$NUM/reviews?per_page=100" --paginate \
      --jq ".[] | select((.body // \"\") | contains(\"$claim_marker\")) | .id" 2>&1); then
      if [ -n "$claim_review_hits" ]; then
        found="pull request review carrying this run's attempt-claim marker ($ATTEMPT_ID)"
        found_via="exact"
      fi
    fi
  fi
fi

# (a) PR referencing #NUM created/updated since STARTED_AT. The
# `#$NUM([^0-9]|$)` boundary is load-bearing: an unanchored substring match
# on "#4" also hits "#42"/"#400" in any PR title/body. sort=updated,
# direction=desc so a push to an OLDER existing PR isn't missed once >50 PRs
# exist (creation-date order would drop it off the first page).
# EXCLUDE_PR_AUTHOR (comma-separated logins) guards against crediting a
# different, concurrently dispatched sibling pipeline's PR when two agents
# are testing against the same issue - each workflow passes the OTHER
# pipelines' bot logins here, never its own. Only applied on an implement
# dispatch, though: on a reply
# dispatch the anchor (issue or PR) is explicit and dispatched deliberately
# at that anchor, so an update to a PR referencing it is valid evidence
# regardless of which pipeline authored the PR - excluding by author there
# would discard a legitimate cross-agent takeover (e.g. this run is a
# @claude reply continuing a PR codex originally opened).
if [ -z "$found" ]; then
  if pr_json=$(gh api "repos/$REPO/pulls?state=all&sort=updated&direction=desc&per_page=50" 2>&1); then
    prs=$(jq -r \
      --arg started "$STARTED_AT" --arg num "$NUM" --arg exclude "$EXCLUDE_PR_AUTHOR" --arg mode "$MODE" \
      '($exclude | split(",") | map(select(length > 0))) as $excluded
       | [.[] | .user.login as $author
              | select(.updated_at >= $started)
              | select($mode == "reply" or ($excluded | index($author)) == null)
              | select(
                  ((.title + " " + (.body // "")) | test("#" + $num + "([^0-9]|$)"))
                  or (.number == ($num | tonumber))
                )]
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

# (d) reply-mode (or runbook-dispatch) comment evidence. EXCLUDE_COMMENT_ID
# skips a scripted pickup comment (if this pipeline posts one): GitHub's
# `since` filter uses updated_at, so a pickup comment the agent itself
# edits during the run would otherwise look like fresh evidence.
if [ -z "$found" ] && { [ "$MODE" = "reply" ] || [ -n "$RUNBOOK" ]; }; then
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

# (e) review-mode PR review evidence - the submitted-review analog of
# clause (d)'s comment check, gated on MODE=review the same way.
if [ -z "$found" ] && [ "$MODE" = "review" ]; then
  if reviews_json=$(gh api "repos/$REPO/pulls/$NUM/reviews?per_page=100" 2>&1); then
    botreviews=$(jq -r \
      --arg login "$EXPECTED_COMMENT_LOGIN" --arg started "$STARTED_AT" \
      '[.[] | select(.user.login == $login) | select(.submitted_at >= $started)]
       | length' <<<"$reviews_json")
    if [ "${botreviews:-0}" -ge 1 ]; then
      found="$EXPECTED_COMMENT_LOGIN submitted a pull request review on #$NUM since $STARTED_AT"
    fi
  else
    errors+=("PR review lookup (gh api repos/$REPO/pulls/$NUM/reviews) failed: $reviews_json")
  fi
fi

if [ -n "$found" ]; then
  # Which path proved it (#645 Phase 4) - the inference clauses ((a)-(e))
  # are only safe to retire "after soak" (see #645), and there is no way to
  # decide that without knowing whether anything still relies on them. This
  # is the observable signal for that decision.
  if [ "$found_via" = "exact" ]; then
    echo "::notice::$AGENT deliverable verified via EXACT attempt-claim marker - no inference needed"
  else
    echo "::notice::$AGENT deliverable verified via INFERENCE (time window + bot login) - no exact attempt-claim marker was found"
  fi
  echo "Deliverable evidence: $found"
  exit 0
fi

if [ "${#errors[@]}" -gt 0 ]; then
  joined=$(printf '%s | ' "${errors[@]}")
  echo "::error::$AGENT deliverable check could not complete - this is a FAILED lookup, distinct from 'no deliverable found': ${joined%' | '}"
  exit 1
fi

echo "NO_DELIVERABLE=1" >> "${GITHUB_ENV:-/dev/null}"
mode_clause=""
if [ "$MODE" = "reply" ] || [ -n "$RUNBOOK" ]; then
  mode_clause=", no qualifying comment posted"
elif [ "$MODE" = "review" ]; then
  mode_clause=", no qualifying pull request review submitted"
fi
echo "::error::$AGENT run completed 'successfully' but produced no deliverable on #$NUM (no PR referencing #$NUM created/updated since $STARTED_AT, issue not closed, no status:needs-human label${mode_clause}). All of its local work may be lost."
exit 1
