#!/usr/bin/env bash
# dispatch-canary.yml failed 7 consecutive scheduled runs with nobody
# notified - a human found it by hand (see this action's directory). This
# is the reusable fix: track ONE durable issue PER WORKFLOW across a failure
# streak, not one issue per failed run (or one fleet issue that an unrelated
# healthy workflow can close), and auto-resolve it when that workflow recovers.
#
# Deliberately never persists state in a file: a state file is itself a
# thing that can silently stop being written, which is the same failure
# mode this whole action exists to catch. The consecutive-failure count is
# instead re-derived live from the watched workflow's own run history via
# the API every time this runs.
#
# Left strict (set -uo pipefail, no -e): every gh/API call below is
# captured explicitly so a failure is reported as a distinct ::error:: and
# the script exits 1 - never silently swallowed, never misreported as
# "nothing to alert on". The caller's composite step is
# continue-on-error: true (see action.yml) specifically so this script
# failing loudly here can never flip the watched workflow's own conclusion.
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${SERVER_URL:?SERVER_URL is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${CANARY_STATUS:?CANARY_STATUS is required}"
: "${WORKFLOW_FILE:?WORKFLOW_FILE is required}"
: "${WORKFLOW_EVENT:=}"
: "${FAILURE_DETAIL:=}"
: "${WORKFLOW_NAME:?WORKFLOW_NAME is required}"
: "${MAINTAINER:?MAINTAINER is required}"

if [[ ! "$WORKFLOW_FILE" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]]; then
  echo "::error::Invalid workflow filename for alert identity: $WORKFLOW_FILE"
  exit 1
fi
if [ -n "$WORKFLOW_EVENT" ] && [[ ! "$WORKFLOW_EVENT" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "::error::Invalid workflow event for alert history: $WORKFLOW_EVENT"
  exit 1
fi
MARKER="<!-- agent-lcars:workflow-alert:v1:$WORKFLOW_FILE -->"
LEGACY_CANARY_MARKER='<!-- agent-lcars:canary-alert:v1 -->'
RUN_URL="$SERVER_URL/$REPO/actions/runs/$RUN_ID"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Every OPEN issue (not PR - the issues endpoint returns both) whose body
# carries the marker. Paginated: an old alert issue could be far enough
# back in a busy issue tracker that a single unpaginated page misses it,
# which would silently create a second tracked issue instead of finding the
# first (same paginate-because-the-marker-is-the-identity-check reasoning
# as verify-deliverable.sh's clause 0).
find_open_alert_issues() {
  local marker_filter
  marker_filter="select((.body // \"\") | contains(\"$MARKER\"))"
  # dispatch-canary.yml shipped before alert identity became per-workflow.
  # Adopt its legacy marker until that incident closes; no other workflow
  # may see or mutate it.
  if [ "$WORKFLOW_FILE" = "dispatch-canary.yml" ]; then
    marker_filter="select(((.body // \"\") | contains(\"$MARKER\")) or ((.body // \"\") | contains(\"$LEGACY_CANARY_MARKER\")))"
  fi
  gh api "repos/$REPO/issues?state=open&per_page=100" --paginate \
    --jq ".[] | select(has(\"pull_request\") | not) | $marker_filter | .number"
}

if ! open_issues_raw=$(find_open_alert_issues 2>&1); then
  echo "::error::Alert issue lookup (gh api repos/$REPO/issues) failed: $open_issues_raw"
  exit 1
fi

open_issue_num=""
if [ -n "$open_issues_raw" ]; then
  # More than one match should never happen, but resolve deterministically to
  # the oldest rather than picking whichever line the API happened to
  # return first.
  open_issue_num=$(sort -n <<<"$open_issues_raw" | head -n1)
  match_count=$(grep -c . <<<"$open_issues_raw")
  if [ "$match_count" -gt 1 ]; then
    echo "::notice::Found $match_count open issues carrying $MARKER; using the oldest (#$open_issue_num)."
  fi
fi

if [ "$CANARY_STATUS" = "success" ]; then
  if [ -z "$open_issue_num" ]; then
    echo "::notice::$WORKFLOW_NAME succeeded and no open alert issue is tracked - nothing to do."
    exit 0
  fi
  recovery_body="$WORKFLOW_NAME recovered: $RUN_URL succeeded at $TIMESTAMP UTC. Closing this alert."
  if ! close_output=$(gh issue close "$open_issue_num" --repo "$REPO" \
    --reason completed --comment "$recovery_body" 2>&1); then
    echo "::error::Failed to post recovery comment and close alert issue #$open_issue_num: $close_output"
    exit 1
  fi
  echo "::notice::$WORKFLOW_NAME recovered - closed alert issue #$open_issue_num."
  exit 0
fi

# --- Failure (or cancelled - e.g. a timeout-minutes kill, same distinction
# report-failure.sh draws) path below: CANARY_STATUS is anything but
# "success". ---

# Consecutive-failure count, derived live from the watched workflow's own
# run history: status=completed server-side excludes in-progress/queued
# runs, and THIS run is also explicitly excluded by id as belt-and-braces -
# it cannot have a final conclusion yet, since we are still executing its
# own last step. Counts back from most recent, most-recent-first, stopping
# at the first "success" - every other completed conclusion (failure,
# cancelled, timed_out, action_required, ...) extends the streak, because
# all of them mean "the canary was not healthy", which is what a human
# staring at a run of failed workflows actually cares about, not the
# fine-grained conclusion label.
#
# Paginated: a single page (previously a flat per_page=50, one request) only
# ever sees the newest 50 completed runs, so once the canary has failed more
# than 50 consecutive times this reported "51" forever, even as the real
# streak - and the still-unseen success that bounds it - kept growing.
# PER_PAGE uses GitHub's own max (100) to minimize round-trips; MAX_PAGES
# bounds the worst case (1000 runs - ~41 days of an hourly canary) so a
# pathological streak can't spin this loop forever. If that bound is hit
# without finding a bounding success (or running out of history entirely),
# the count is reported as a floor ("at least N"), never as a falsely
# precise exact number.
PER_PAGE=100
MAX_PAGES=10

consecutive_prior=0
found_success=0
ran_out_of_history=0
page=1
while [ "$page" -le "$MAX_PAGES" ]; do
  # raw_count is this page's actual API item count, BEFORE the .id !=
  # RUN_ID exclusion below - "was this a short (i.e. last) page" must be
  # judged against what the API actually returned, not against the
  # filtered count. Otherwise the one run in the whole history that could
  # ever match RUN_ID (which, per the comment above, should never happen
  # server-side anyway - status=completed already excludes it) would make a
  # genuinely full page look short by exactly one and stop pagination a
  # page early.
  run_history_path="repos/$REPO/actions/workflows/$WORKFLOW_FILE/runs?status=completed&per_page=$PER_PAGE&page=$page"
  if [ -n "$WORKFLOW_EVENT" ]; then
    run_history_path="$run_history_path&event=$WORKFLOW_EVENT"
  fi
  if ! page_payload=$(gh api "$run_history_path" \
    --jq '{raw_count: (.workflow_runs | length), conclusions: [.workflow_runs[] | select(.id != '"$RUN_ID"') | .conclusion]}' 2>&1); then
    echo "::error::Consecutive-failure count lookup (gh api repos/$REPO/actions/workflows/$WORKFLOW_FILE/runs, page $page) failed: $page_payload"
    exit 1
  fi

  raw_count=$(jq -r '.raw_count' <<<"$page_payload")
  if [ "$raw_count" -eq 0 ]; then
    # No runs at all on this page - prior pages already exhausted the
    # workflow's entire history without a success in sight.
    ran_out_of_history=1
    break
  fi

  while IFS= read -r concl; do
    [ -z "$concl" ] && continue
    if [ "$concl" = "success" ]; then
      found_success=1
      break
    fi
    consecutive_prior=$((consecutive_prior + 1))
  done < <(jq -r '.conclusions[]' <<<"$page_payload")

  if [ "$found_success" -eq 1 ]; then
    break
  fi

  if [ "$raw_count" -lt "$PER_PAGE" ]; then
    # A short page is the API's own signal that this was the last one.
    ran_out_of_history=1
    break
  fi

  page=$((page + 1))
done
count=$((consecutive_prior + 1))

if [ "$found_success" -eq 0 ] && [ "$ran_out_of_history" -eq 0 ]; then
  # Hit MAX_PAGES with every conclusion so far unhealthy and history not yet
  # exhausted - the true streak (and its bounding success, if any) is still
  # unseen beyond this point. Report a floor, not a wrong exact number.
  count_label="at least $count"
else
  count_label="$count"
fi

body="$WORKFLOW_NAME failed.

- Run: $RUN_URL
- Time (UTC): $TIMESTAMP
- Consecutive failures: $count_label"

if [ -n "$FAILURE_DETAIL" ]; then
  body="$body
- Failure detail: $FAILURE_DETAIL"
fi

if [ -n "$open_issue_num" ]; then
  if ! comment_output=$(gh issue comment "$open_issue_num" --repo "$REPO" --body "$body" 2>&1); then
    echo "::error::Failed to comment on existing alert issue #$open_issue_num: $comment_output"
    exit 1
  fi
  echo "::notice::Commented on existing alert issue #$open_issue_num ($count_label consecutive failure(s))."
  exit 0
fi

issue_body="$MARKER

$body"

if ! create_output=$(gh issue create --repo "$REPO" \
  --title "$WORKFLOW_NAME is failing" \
  --body "$issue_body" \
  --label status:needs-human \
  --assignee "$MAINTAINER" 2>&1); then
  echo "::error::Failed to create alert issue: $create_output"
  exit 1
fi
echo "::notice::Created alert issue for $count_label consecutive failure(s): $create_output"
