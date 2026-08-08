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
#       below for why). A REFERENCING PR (title/body mentions #NUM, but
#       isn't #NUM itself) must also be authored by EXPECTED_COMMENT_LOGIN -
#       this run's own agent identity as GitHub actually attributes it (see
#       clause (a) below for why that login, and not AGENT_GIT_LOGIN, is the
#       right one) - otherwise a bystander's PR that merely discusses the
#       issue (e.g. a human's unrelated fix PR whose body says "see #650")
#       would satisfy the gate for work no agent did (confirmed live on
#       #650 generation 9). Also matches when #NUM IS the PR's own number,
#       regardless of author, not just a title/body reference to it - an
#       agent:*-on-PR takeover dispatch (#567) has the anchor and the
#       pushed-to PR be the exact same object, which never mentions its own
#       number in its own title or body, and which may have been opened by
#       a human;
#   (b) the issue was closed since STARTED_AT;
#   (c) the status:needs-human label was applied since STARTED_AT AND is
#       still present (the sanctioned blocked/clarifying-question ending).
#       Both halves are load-bearing: current presence alone lets a stale
#       label from an earlier run satisfy every later run's gate forever
#       (same reason (b) checks closed_at, not a bare state=="closed"),
#       while a past `labeled` event alone keeps counting after the park
#       was removed, since timeline events are permanent;
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
outcome_kind=""
outcome_reference=""
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
      outcome_kind="pull-request"
      # A duplicated claim marker still proves a PR deliverable exists, but
      # it no longer identifies ONE object that can later be called merged.
      # Persist no reference in that anomalous case rather than selecting an
      # arbitrary API-list entry and misattributing its future merge.
      if [[ "$claim_pr_hits" != *$'\n'* ]]; then
        outcome_reference="$claim_pr_hits"
      fi
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
        outcome_kind="comment"
        if claim_no_op_hits=$(gh api "repos/$REPO/issues/$NUM/comments?per_page=100" --paginate \
          --jq ".[] | select((.body // \"\") | contains(\"$claim_marker\") and contains(\"<!-- agent-result:v1:no-op -->\")) | .id" 2>/dev/null) && \
          [ -n "$claim_no_op_hits" ]; then
          found="evidence-backed structured no-op carrying this run's attempt-claim marker ($ATTEMPT_ID)"
          outcome_kind="no-op"
        fi
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
        outcome_kind="review"
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
#
# A REFERENCING PR (not the anchor itself) must additionally be authored by
# THIS run's own identity, $expected (= EXPECTED_COMMENT_LOGIN), or it does
# not count - without this, ANY PR that merely mentions #NUM, by ANY author,
# satisfies the gate, which is exactly what let a human's unrelated PR
# (jlapenna/agent-lcars#711, whose body happened to say "Issue #650") get
# credited as issue #650 generation 9's deliverable when no agent produced
# anything. $expected, not AGENT_GIT_LOGIN: AGENT_GIT_LOGIN is only the
# local `git config user.name` used for commit authorship (see
# agent-setup/action.yml) - for the claude lane it is the fleet-claim login
# `jclaw-bot`, which never appears as a PR's GitHub-attributed `.user.login`
# (that's `claude[bot]`, minted by a wholly separate token exchange the
# claude-code-action performs internally). $expected is what clauses (d)
# and (e) already trust for this exact purpose, and, unlike AGENT_GIT_LOGIN,
# it verifiably matches the real `.user.login` GitHub records for all three
# lanes. Skipped in reply mode for the same reason EXCLUDE_PR_AUTHOR is
# skipped there - the explicit, deliberately-dispatched anchor already makes
# any update to a referencing PR valid evidence regardless of author (e.g.
# a @claude reply crediting a PR codex originally opened, authored as
# agent-lcars[bot], not claude[bot]). The takeover case (#NUM IS the PR's
# own number) is exempt in every mode, same as EXCLUDE_PR_AUTHOR above:
# that PR may be authored by a human (#567).
if [ -z "$found" ]; then
  if pr_json=$(gh api "repos/$REPO/pulls?state=all&sort=updated&direction=desc&per_page=50" 2>&1); then
    matching_prs=$(jq -c \
      --arg started "$STARTED_AT" --arg num "$NUM" --arg exclude "$EXCLUDE_PR_AUTHOR" \
      --arg mode "$MODE" --arg expected "$EXPECTED_COMMENT_LOGIN" \
      '($exclude | split(",") | map(select(length > 0))) as $excluded
       | [.[] | .user.login as $author
              | (.number == ($num | tonumber)) as $is_anchor
              | select(.updated_at >= $started)
              | select($mode == "reply" or ($excluded | index($author)) == null)
              | select($mode == "reply" or $is_anchor or $author == $expected)
              | select(
                  ((.title + " " + (.body // "")) | test("#" + $num + "([^0-9]|$)"))
                  or $is_anchor
                )]
       | map(.number)' <<<"$pr_json")
    matching_pr_count=$(jq -r 'length' <<<"$matching_prs")
    if [ "${matching_pr_count:-0}" -gt 0 ]; then
      found="PR referencing #$NUM created/updated since $STARTED_AT"
      outcome_kind="pull-request"
      if [ "$matching_pr_count" -eq 1 ]; then
        outcome_reference=$(jq -r '.[0]' <<<"$matching_prs")
      fi
    fi
  else
    errors+=("PR list lookup (gh api repos/$REPO/pulls) failed: $pr_json")
  fi
fi

# (b) issue closed since STARTED_AT - closed_at, not just current
# state=="closed", because a pre-existing closure (e.g. another pipeline
# closed it moments before this run started) must not count as THIS run's
# deliverable.
needs_human_now=
if [ -z "$found" ]; then
  if issue_json=$(gh api "repos/$REPO/issues/$NUM" 2>&1); then
    closed_at=$(jq -r 'if .state == "closed" then (.closed_at // "") else "" end' <<<"$issue_json")
    if [ -n "$closed_at" ] && [ "$closed_at" \> "$STARTED_AT" ]; then
      found="issue #$NUM closed at $closed_at (after $STARTED_AT)"
      outcome_kind="closed"
    fi
    # Current presence, for clause (c) below to AND against its own
    # recency check - see there for why both halves are required.
    needs_human_now=$(jq -r '[.labels[].name] | contains(["status:needs-human"])' <<<"$issue_json")
  else
    errors+=("Issue lookup (gh api repos/$REPO/issues/$NUM) failed: $issue_json")
  fi
fi

# (c) status:needs-human label applied since STARTED_AT (the sanctioned
# blocked/clarifying-question ending) - not just current presence, for the
# same reason (b) checks closed_at instead of a bare state=="closed": the
# labels array on the issue object carries no timestamps, so a label
# applied by an EARLIER run (or another pipeline) before this run even
# started would otherwise satisfy every subsequent run's gate
# unconditionally, forever, no matter what that later run itself did -
# confirmed live on #650, where a stale park from generation 7 let
# generation 8's own no-op run report success. So this walks the issue
# TIMELINE's `labeled` events instead, which do carry `created_at`
# (paginated - a long-lived issue can accumulate many). An agent that
# legitimately parks the issue during its OWN run still passes; a stale,
# pre-existing park does not.
#
# Recency is necessary but NOT sufficient, so this ANDs it with current
# presence: a `labeled` event is permanent, so a park applied during this
# run and then REMOVED (the run became unblocked, or a human unparked it)
# would otherwise keep satisfying the gate forever even though the issue is
# no longer parked and the run may have produced nothing else. Both halves
# are required - applied by THIS run, and still parked now.
if [ -z "$found" ] && [ "$needs_human_now" = "true" ]; then
  if timeline_hits=$(gh api "repos/$REPO/issues/$NUM/timeline?per_page=100" --paginate \
    --jq ".[] | select(.event == \"labeled\" and (.label.name // \"\") == \"status:needs-human\" and .created_at >= \"$STARTED_AT\") | .created_at" 2>&1); then
    if [ -n "$timeline_hits" ]; then
      found="status:needs-human label applied on #$NUM since $STARTED_AT"
      outcome_kind="park"
    fi
  else
    errors+=("Issue timeline lookup (gh api repos/$REPO/issues/$NUM/timeline) failed: $timeline_hits")
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
      outcome_kind="comment"
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
      outcome_kind="review"
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
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "outcome-kind=${outcome_kind:-unknown-success}" >> "$GITHUB_OUTPUT"
    if [ -n "$outcome_reference" ]; then
      echo "outcome-reference=$outcome_reference" >> "$GITHUB_OUTPUT"
    fi
  fi
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
