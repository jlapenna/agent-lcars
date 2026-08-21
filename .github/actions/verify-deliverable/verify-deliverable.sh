#!/usr/bin/env bash
# Same gate every worker uses (agent-protocol.md #5): an agent can reason to
# a genuine conclusion and stop without ever posting it, so a bare "success"
# job conclusion is never trusted on its own.
#
# EXACT-MARKER ONLY. A run passes ONLY when a BOT-AUTHORED artifact (PR,
# comment, or - on a review dispatch - a pull request review) carries THIS
# run's own hidden `<!-- attempt-claim:<attempt-id> -->` marker (see
# libs/dispatch-contracts/src/marker.ts's formatClaimMarker and
# agent-protocol.md #5). The marker names one specific attempt, so a marker
# for a different attempt - or no marker at all - does not satisfy it: a
# missing marker fails closed as a genuine no-deliverable. ATTEMPT_ID is
# required; its absence is a caller configuration error, never a signal to
# weaken the gate.
#
# The legacy time-window/login inference mode (clauses (a)-(e): a
# STARTED_AT-windowed referencing PR, an issue closure, a fresh
# status:needs-human label, an EXPECTED_COMMENT_LOGIN comment or review)
# was DELETED, with no fallback retained. Inference could never tell this
# run's own work from an unrelated bot touch in the same window - a human
# PR whose body merely said "Issue #650" was credited as a run's
# deliverable (#711, #650 generation 9) - and keeping it reachable meant
# any consumer that forgot to pass identity silently got the weaker gate.
# Every fleet consumer passes ATTEMPT_ID as of the #1201-era flips:
# agent-lcars's own three lanes (#815/#645 Phase 4), homelab's three lanes
# (homelab#697; the inert legacy env removed in homelab#701), and
# sprinkles' three lanes (the exact-marker flip PR).
#
# The `.user.type == "Bot"` requirement is #1223. The marker was treated as
# unforgeable identity, but it is a plain string: `g<gen>:<repo>#<n>/r<gen>`,
# derivable from public issue state and printed in run logs, issue
# comments, and documentation. A human PR that merely QUOTED a live marker
# while explaining this mechanism satisfied that run's gate and marked it
# success, having produced nothing - the exact shape of the #711 incident.
# Requiring a bot author is strictly narrowing: the marker must still be
# exact, so this does not reintroduce the inference #815 removed. It rules
# out only bystanders, and every lane's real artifacts are bot-authored
# (claude[bot], agent-lcars[bot]).
#
# Deliberately `.user.type`, not a specific login: claude.yml's PRs are
# authored claude[bot] (its action mints that identity itself) while its
# `gh` comments come from agent-lcars[bot], so no single expected login
# covers one lane's own artifacts. On an agent:*-on-PR takeover of a
# HUMAN-authored PR, stamping that PR's body does not count; the shared
# protocol's other sanctioned path, a bot-authored comment carrying the
# marker, still does.
#
# Uses the REST list/view endpoints throughout (not `gh pr list`/`gh issue
# view --json ... | GraphQL-backed flags) - see docs/bot-identity-formats.md:
# REST shape is canonical in this repo, and mixing REST- and GraphQL-shaped
# logins without translating is what silently broke #175.
#
# A FAILED lookup is never silently treated as "no deliverable found": each
# lookup's `gh` call is captured without swallowing its exit status, and any
# failure is collected and reported as a distinct, named error instead of
# falling through to the generic "no deliverable" message.
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${AGENT:?AGENT is required}"
: "${REPO:?REPO is required}"
: "${NUM:?NUM is required}"
# MODE stays load-bearing even in exact-only validation: only MODE=review
# additionally checks pull request reviews for the marker - the reviews
# endpoint 404s when #NUM is not a pull request, and review mode is the one
# case this script already knows it is.
: "${MODE:?MODE is required}"

if [ -z "${ATTEMPT_ID:-}" ]; then
  echo "::error::ATTEMPT_ID is required: this gate is exact-marker-only. The run's deliverable must carry its own <!-- attempt-claim:<attempt-id> --> marker; the legacy time-window/login inference mode (STARTED_AT/EXPECTED_COMMENT_LOGIN) was deleted because every fleet consumer now passes ATTEMPT_ID."
  exit 1
fi

found=""
errors=()

claim_marker="<!-- attempt-claim:${ATTEMPT_ID} -->"

# Every lookup here paginates. These have no sort and no time filter -- the
# marker IS the identity check - so "the first page" is an arbitrary slice,
# and a marker one page deep would read as a genuine absence.

# PRs: any BOT-AUTHORED PR (regardless of which bot, or of update time)
# whose title or body carries this exact marker. See #1223 in the header:
# without the author test, a human PR that merely quotes the marker counts.
if claim_pr_hits=$(gh api "repos/$REPO/pulls?state=all&per_page=100" --paginate \
  --jq ".[] | select(.user.type == \"Bot\") | select(((.title // \"\") + \"\\n\" + (.body // \"\")) | contains(\"$claim_marker\")) | .number" 2>&1); then
  if [ -n "$claim_pr_hits" ]; then
    found="PR carrying this run's attempt-claim marker ($ATTEMPT_ID)"
  fi
else
  errors+=("PR list lookup (gh api repos/$REPO/pulls) failed: $claim_pr_hits")
fi

# Comments: not gated on MODE - a marker stamped on a comment is exact
# evidence regardless of dispatch mode.
if [ -z "$found" ]; then
  if claim_comment_hits=$(gh api "repos/$REPO/issues/$NUM/comments?per_page=100" --paginate \
    --jq ".[] | select(.user.type == \"Bot\") | select((.body // \"\") | contains(\"$claim_marker\")) | .id" 2>&1); then
    if [ -n "$claim_comment_hits" ]; then
      found="comment carrying this run's attempt-claim marker ($ATTEMPT_ID)"
      if claim_no_op_hits=$(gh api "repos/$REPO/issues/$NUM/comments?per_page=100" --paginate \
        --jq ".[] | select(.user.type == \"Bot\") | select((.body // \"\") | contains(\"$claim_marker\") and contains(\"<!-- agent-result:v1:no-op -->\")) | .id" 2>/dev/null) && \
        [ -n "$claim_no_op_hits" ]; then
        found="evidence-backed structured no-op carrying this run's attempt-claim marker ($ATTEMPT_ID)"
      fi
    fi
  else
    errors+=("Attempt-claim comment lookup (gh api repos/$REPO/issues/$NUM/comments) failed: $claim_comment_hits")
  fi
fi

# Reviews: gated on MODE=review - `pulls/$NUM/reviews` 404s when #NUM is
# not a pull request, and review mode is the one case this script already
# knows #NUM is one.
if [ -z "$found" ] && [ "$MODE" = "review" ]; then
  if claim_review_hits=$(gh api "repos/$REPO/pulls/$NUM/reviews?per_page=100" --paginate \
    --jq ".[] | select(.user.type == \"Bot\") | select((.body // \"\") | contains(\"$claim_marker\")) | .id" 2>&1); then
    if [ -n "$claim_review_hits" ]; then
      found="pull request review carrying this run's attempt-claim marker ($ATTEMPT_ID)"
    fi
  else
    errors+=("PR review lookup (gh api repos/$REPO/pulls/$NUM/reviews) failed: $claim_review_hits")
  fi
fi

if [ -n "$found" ]; then
  echo "::notice::$AGENT deliverable verified via exact attempt-claim marker"
  echo "Deliverable evidence: $found"
  # No $GITHUB_OUTPUT writes: the former outcome-kind/outcome-reference
  # step outputs were retired 2026-08-17 -- nothing ever mapped this
  # step's outputs (agent-fallback-finalize.yml re-derives outcome
  # evidence from job metadata and exact attempt markers itself).
  exit 0
fi

if [ "${#errors[@]}" -gt 0 ]; then
  joined=$(printf '%s | ' "${errors[@]}")
  echo "::error::$AGENT deliverable check could not complete - this is a FAILED lookup, distinct from 'no deliverable found': ${joined%' | '}"
  exit 1
fi

echo "NO_DELIVERABLE=1" >> "${GITHUB_ENV:-/dev/null}"
checked="No PR or comment"
if [ "$MODE" = "review" ]; then
  checked="No PR, comment, or pull request review"
fi
echo "::error::$AGENT run completed 'successfully' but produced no deliverable on #$NUM: $checked carries this run's exact attempt-claim marker ($ATTEMPT_ID). All of its local work may be lost."
exit 1
