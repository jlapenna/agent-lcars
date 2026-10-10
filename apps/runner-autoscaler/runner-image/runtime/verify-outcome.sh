#!/usr/bin/env bash
# Native QueueExecutor exact-marker outcome verifier.
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
# QueueExecutor passes ATTEMPT_ID for every provider run.
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
# Deliberately `.user.type`, not a specific login: QueueExecutor may create
# artifacts through either the provider identity or `agent-lcars[bot]`. On an
# agent:*-on-PR takeover of a HUMAN-authored PR, stamping that PR's body does
# not count; a bot-authored comment carrying the marker still does.
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

command -v gh >/dev/null || { echo '::error::gh is required' >&2; exit 1; }
: "${AGENT:?AGENT is required}"
: "${REPO:?REPO is required}"
# Empty for a native work-item run: there is no issue or pull request
# number to anchor a comment/review lookup against. The PR-marker lookup
# below is the only one that ever runs in that case (agent-protocol.md
# §5, "Work anchor").
NUM="${NUM:-}"
# MODE stays load-bearing even in exact-only validation: only MODE=review
# additionally checks pull request reviews for the marker - the reviews
# endpoint 404s when #NUM is not a pull request, and review mode is the one
# case this script already knows it is.
: "${MODE:?MODE is required}"

if [ -z "${ATTEMPT_ID:-}" ]; then
  echo "::error::ATTEMPT_ID is required: this gate is exact-marker-only. The run's deliverable must carry its own <!-- attempt-claim:<attempt-id> --> marker; the legacy time-window/login inference mode (STARTED_AT/EXPECTED_COMMENT_LOGIN) was deleted because every fleet consumer now passes ATTEMPT_ID."
  exit 1
fi

# The private completion file is produced after the provider stops. Never
# accept an agent-written file or parse links from its stdout/final message.
if [ -n "${VERIFIED_OUTCOME_FILE:-}" ]; then
  rm -f -- "$VERIFIED_OUTCOME_FILE" || exit 1
fi
found=""
errors=()
claim_marker="<!-- attempt-claim:${ATTEMPT_ID} -->"
pr_hits='[]'
comment_hits='[]'
review_hits='[]'

# Read each paginated REST collection once, then classify and carry the very
# same verified object. Re-querying for its URL can credit a different artifact
# or lose evidence when a second lookup fails.
lookup_hits() {
  local endpoint="$1" kind="$2" pages hits
  if ! pages=$(gh api "$endpoint" --paginate --slurp 2>&1); then
    errors+=("$kind lookup (gh api $endpoint) failed: $pages")
    return 1
  fi
  if ! hits=$(jq -ce --arg marker "$claim_marker" --arg kind "$kind" '
    [ .[][]
      | select(.user.type == "Bot")
      | select((if $kind == "PR" then ((.title // "") + "\n" + (.body // "")) else (.body // "") end) | contains($marker))
    ]' <<< "$pages" 2>&1); then
    errors+=("$kind lookup returned invalid REST data: $hits")
    return 1
  fi
  LOOKUP_HITS="$hits"
}

if lookup_hits "repos/$REPO/pulls?state=all&per_page=100" PR; then
  pr_hits="$LOOKUP_HITS"
fi
# A structured park must be checked even beside a partial PR.
if [ -n "$NUM" ]; then
  if lookup_hits "repos/$REPO/issues/$NUM/comments?per_page=100" comment; then
    comment_hits="$LOOKUP_HITS"
  fi
fi
if [ "$MODE" = review ] && [ -n "$NUM" ] &&
  [ "$(jq length <<< "$pr_hits")" -eq 0 ] && [ "$(jq length <<< "$comment_hits")" -eq 0 ]; then
  if lookup_hits "repos/$REPO/pulls/$NUM/reviews?per_page=100" review; then
    review_hits="$LOOKUP_HITS"
  fi
fi

# Preserve the runner's existing priority: park overrides a partial PR;
# otherwise PR, structured no-op, comment, then mode-gated review. Select the
# latest matching comment/review ID; every candidate already passed BOTH
# bot-author and exact-attempt tests. Multiple matching PRs remain ambiguous.
verified=$(jq -cn --argjson prs "$pr_hits" --argjson comments "$comment_hits" \
  --argjson reviews "$review_hits" --argjson number "${NUM:-0}" '
  def reference($kind; $number):
    if $kind == "pull-request" then
      if (.number | type) == "number" then {kind:$kind, number:.number} else null end
    elif (.id | type) == "number" and (.html_url | type) == "string" then
      {kind:$kind, number:$number, id:.id, url:.html_url}
    else null end;
  ($comments | map(select((.body // "") | contains("<!-- agent-result:v1:park -->"))) | sort_by(.id) | last) as $park |
  ($comments | map(select((.body // "") | contains("<!-- agent-result:v1:no-op -->"))) | sort_by(.id) | last) as $noop |
  (if ($prs | length) == 1 then ($prs[0] | reference("pull-request"; 0)) else null end) as $pr |
  if $park != null then
    ($park | reference("comment"; $number)) as $comment |
    {outcome:"park", outcomeReference:
      (if $pr != null then $pr + (if $comment != null then {related:[$comment]} else {} end) else $comment end)}
  elif ($prs | length) > 0 then {outcome:"pull-request", outcomeReference:$pr}
  elif $noop != null then {outcome:"no-op", outcomeReference:($noop | reference("comment"; $number))}
  elif ($comments | length) > 0 then {outcome:"comment", outcomeReference:($comments | sort_by(.id) | last | reference("comment"; $number))}
  elif ($reviews | length) > 0 then {outcome:"review", outcomeReference:($reviews | sort_by(.id) | last | reference("review"; $number))}
  else null end') || exit 1

if [ "$verified" != null ]; then
  found="$(jq -r .outcome <<< "$verified") carrying this run's attempt-claim marker ($ATTEMPT_ID)"
  if [ -n "${VERIFIED_OUTCOME_FILE:-}" ]; then
    printf '%s\n' "$verified" > "$VERIFIED_OUTCOME_FILE" || exit 1
  fi
  echo "::notice::$AGENT deliverable verified via exact attempt-claim marker"
  echo "Deliverable evidence: $found"
  exit 0
fi

if [ "${#errors[@]}" -gt 0 ]; then
  joined=$(printf '%s | ' "${errors[@]}")
  echo "::error::$AGENT deliverable check could not complete - this is a FAILED lookup, distinct from 'no deliverable found': ${joined%' | '}"
  exit 1
fi

echo "NO_DELIVERABLE=1" >> "${RUNTIME_ENV:-/dev/null}"
checked="No PR"
if [ -n "$NUM" ]; then
  checked="No PR or comment"
  if [ "$MODE" = "review" ]; then
    checked="No PR, comment, or pull request review"
  fi
fi
# "#$NUM" when this run has an issue/PR anchor, "this work item" for a
# native work-item run that has none.
anchor_label="${NUM:+#$NUM}"
anchor_label="${anchor_label:-this work item}"
echo "::error::$AGENT run completed 'successfully' but produced no deliverable on $anchor_label: $checked carries this run's exact attempt-claim marker ($ATTEMPT_ID). All of its local work may be lost."
exit 1
