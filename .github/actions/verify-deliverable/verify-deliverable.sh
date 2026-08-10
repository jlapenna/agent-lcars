#!/usr/bin/env bash
# Same gate every worker uses (agent-protocol.md #5): an agent can reason to
# a genuine conclusion and stop without ever posting it, so a bare "success"
# job conclusion is never trusted on its own.
#
# A run passes ONLY when an exact artifact carries THIS run's own hidden
# `<!-- attempt-claim:<attempt-id> -->` marker (see
# libs/dispatch-contracts/src/marker.ts's formatClaimMarker and
# agent-protocol.md #5), on one of:
#   - a PR (title or body) - regardless of author or update time, because the
#     marker itself is the identity check;
#   - an issue/PR comment - also recognizing the exact claimed no-op result
#     when `<!-- agent-result:v1:no-op -->` is on the SAME comment as the
#     claim marker; or
#   - (review dispatches only, MODE=review) a pull request review body -
#     `pulls/$NUM/reviews` 404s when #NUM is not itself a pull request, and
#     review mode is the one case this script already knows it is.
#
# #815 retired the five inference clauses this script used to accept
# alongside the exact marker: a PR referencing #NUM created/updated inside a
# STARTED_AT time window (guarded by an EXCLUDE_PR_AUTHOR sibling-pipeline
# exclusion list), the issue closing, a status:needs-human label appearing,
# an expected bot login posting a bare comment on a reply/runbook dispatch,
# or a bare PR review from that same login. Those clauses were migration
# compatibility paths for the period before every live lane stamped the
# exact marker; keeping them meant a time window plus a shared bot login
# (codex and opencode both push as agent-lcars[bot]) could credit an
# UNRELATED artifact touched by the same identity during the same window to
# a run that produced nothing - confirmed live on #650 generation 9, where a
# human's PR #711 that merely said "Issue #650" in its body got credited as
# #650's own deliverable. The exact marker has no such gap: it names one
# specific attempt, so an artifact for a different attempt - or no marker at
# all - never satisfies this check, no matter who authored it or when.
#
# Uses the REST list/view endpoints throughout (not `gh pr list`/`gh issue
# view --json ... | GraphQL-backed flags) - see docs/bot-identity-formats.md:
# REST shape is canonical in this repo, and mixing REST- and GraphQL-shaped
# logins without translating is what silently broke #175.
#
# A FAILED lookup is never silently treated as "no deliverable found": each
# check's `gh` call is captured without swallowing its exit status, and any
# failure is collected and reported as a distinct, named error instead of
# falling through to the generic "no deliverable" message. Nothing repeats a
# failed lookup any more (there is no second, inference-based clause left to
# fall back to), so every failure is recorded unconditionally.
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${AGENT:?AGENT is required}"
: "${REPO:?REPO is required}"
: "${NUM:?NUM is required}"
: "${MODE:?MODE is required}"
# Required, not optional: every real dispatch is bound at broker preflight
# (dispatch-bootstrap/action.yml's "Verify broker binding" step, which always
# runs before the agent step in claude.yml/codex.yml/opencode.yml), and
# preflight always publishes this via dispatch-broker's own "Publish attempt
# identity" step. There is no longer a code path that reaches this script
# without one.
: "${ATTEMPT_ID:?ATTEMPT_ID is required}"

claim_marker="<!-- attempt-claim:${ATTEMPT_ID} -->"

found=""
outcome_kind=""
outcome_reference=""
errors=()

# PRs: any PR (regardless of author or update time - the marker itself is
# the identity check) whose title or body carries this exact marker.
#
# No sort and no time filter: the marker IS the identity check, so "the
# first page" would be an arbitrary slice and a marker one page deep would
# read as a genuine absence.
if claim_pr_hits=$(gh api "repos/$REPO/pulls?state=all&per_page=100" --paginate \
  --jq ".[] | select(((.title // \"\") + \"\\n\" + (.body // \"\")) | contains(\"$claim_marker\")) | .number" 2>&1); then
  if [ -n "$claim_pr_hits" ]; then
    found="PR carrying this run's attempt-claim marker ($ATTEMPT_ID)"
    outcome_kind="pull-request"
    # A duplicated claim marker still proves a PR deliverable exists, but it
    # no longer identifies ONE object that can later be called merged.
    # Persist no reference in that anomalous case rather than selecting an
    # arbitrary API-list entry and misattributing its future merge.
    if [[ "$claim_pr_hits" != *$'\n'* ]]; then
      outcome_reference="$claim_pr_hits"
    fi
  fi
else
  errors+=("PR list lookup (gh api repos/$REPO/pulls) failed: $claim_pr_hits")
fi

# Comments: any issue/PR comment on #NUM carrying this exact marker, in
# every dispatch mode - a marker stamped on a comment is exact evidence
# regardless of MODE, unlike the retired reply/runbook-only inference clause.
if [ -z "$found" ]; then
  if claim_comment_hits=$(gh api "repos/$REPO/issues/$NUM/comments?per_page=100" --paginate \
    --jq ".[] | select((.body // \"\") | contains(\"$claim_marker\")) | .id" 2>&1); then
    if [ -n "$claim_comment_hits" ]; then
      found="comment carrying this run's attempt-claim marker ($ATTEMPT_ID)"
      outcome_kind="comment"
      if claim_no_op_hits=$(gh api "repos/$REPO/issues/$NUM/comments?per_page=100" --paginate \
        --jq ".[] | select((.body // \"\") | contains(\"$claim_marker\") and contains(\"<!-- agent-result:v1:no-op -->\")) | .id" 2>/dev/null) && \
        [ -n "$claim_no_op_hits" ]; then
        found="evidence-backed structured no-op carrying this run's attempt-claim marker ($ATTEMPT_ID)"
        outcome_kind="no-op"
      fi
    fi
  else
    errors+=("Attempt-claim comment lookup (gh api repos/$REPO/issues/$NUM/comments) failed: $claim_comment_hits")
  fi
fi

# Reviews: gated on MODE=review, same reason as the header comment above.
if [ -z "$found" ] && [ "$MODE" = "review" ]; then
  if claim_review_hits=$(gh api "repos/$REPO/pulls/$NUM/reviews?per_page=100" --paginate \
    --jq ".[] | select((.body // \"\") | contains(\"$claim_marker\")) | .id" 2>&1); then
    if [ -n "$claim_review_hits" ]; then
      found="pull request review carrying this run's attempt-claim marker ($ATTEMPT_ID)"
      outcome_kind="review"
    fi
  else
    errors+=("PR review lookup (gh api repos/$REPO/pulls/$NUM/reviews) failed: $claim_review_hits")
  fi
fi

if [ -n "$found" ]; then
  echo "::notice::$AGENT deliverable verified via exact attempt-claim marker"
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
checked="No PR or comment"
if [ "$MODE" = "review" ]; then
  checked="No PR, comment, or pull request review"
fi
echo "::error::$AGENT run completed 'successfully' but produced no deliverable on #$NUM: $checked carries this run's exact attempt-claim marker ($ATTEMPT_ID). All of its local work may be lost."
exit 1
