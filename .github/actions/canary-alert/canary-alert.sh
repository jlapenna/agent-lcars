#!/usr/bin/env bash
# dispatch-canary.yml failed 7 consecutive scheduled runs with nobody
# notified - a human found it by hand (see this action's directory). This
# is the fix: track ONE durable issue across a failure streak (the marker
# below), not one issue per failed run, and auto-resolve it the moment the
# canary recovers - an alert that only ever opens becomes noise and gets
# ignored, which is the exact failure mode this closes.
#
# Deliberately never persists state in a file: a state file is itself a
# thing that can silently stop being written, which is the same failure
# mode this whole action exists to catch. The consecutive-failure count is
# instead re-derived live from the canary workflow's own run history via
# the API every time this runs.
#
# Left strict (set -uo pipefail, no -e): every gh/API call below is
# captured explicitly so a failure is reported as a distinct ::error:: and
# the script exits 1 - never silently swallowed, never misreported as
# "nothing to alert on". The caller's composite step is
# continue-on-error: true (see action.yml) specifically so this script
# failing loudly here can never flip the canary job's own conclusion.
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${SERVER_URL:?SERVER_URL is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${CANARY_STATUS:?CANARY_STATUS is required}"
: "${WORKFLOW_FILE:?WORKFLOW_FILE is required}"
: "${WORKFLOW_NAME:?WORKFLOW_NAME is required}"
: "${MAINTAINER:?MAINTAINER is required}"

MARKER='<!-- agent-lcars:canary-alert:v1 -->'
RUN_URL="$SERVER_URL/$REPO/actions/runs/$RUN_ID"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Every OPEN issue (not PR - the issues endpoint returns both) whose body
# carries the marker. Paginated: an old alert issue could be far enough
# back in a busy issue tracker that a single unpaginated page misses it,
# which would silently create a second tracked issue instead of finding the
# first (same paginate-because-the-marker-is-the-identity-check reasoning
# as verify-deliverable.sh's clause 0).
find_open_alert_issues() {
  gh api "repos/$REPO/issues?state=open&per_page=100" --paginate \
    --jq ".[] | select(has(\"pull_request\") | not) | select((.body // \"\") | contains(\"$MARKER\")) | .number"
}

if ! open_issues_raw=$(find_open_alert_issues 2>&1); then
  echo "::error::Alert issue lookup (gh api repos/$REPO/issues) failed: $open_issues_raw"
  exit 1
fi

open_issue_num=""
if [ -n "$open_issues_raw" ]; then
  # More than one match should never happen (dispatch-canary-run's
  # concurrency group serializes runs), but resolve deterministically to
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
    echo "::notice::Canary succeeded and no open alert issue is tracked - nothing to do."
    exit 0
  fi
  recovery_body="$WORKFLOW_NAME recovered: $RUN_URL succeeded at $TIMESTAMP UTC. Closing this alert."
  if ! close_output=$(gh issue close "$open_issue_num" --repo "$REPO" \
    --reason completed --comment "$recovery_body" 2>&1); then
    echo "::error::Failed to post recovery comment and close alert issue #$open_issue_num: $close_output"
    exit 1
  fi
  echo "::notice::Canary recovered - closed alert issue #$open_issue_num."
  exit 0
fi

# --- Failure (or cancelled - e.g. a timeout-minutes kill, same distinction
# report-failure.sh draws) path below: CANARY_STATUS is anything but
# "success". ---

# Consecutive-failure count, derived live from the canary workflow's own
# run history: status=completed server-side excludes in-progress/queued
# runs, and THIS run is also explicitly excluded by id as belt-and-braces -
# it cannot have a final conclusion yet, since we are still executing its
# own last step. Counts back from most recent, most-recent-first, stopping
# at the first "success" - every other completed conclusion (failure,
# cancelled, timed_out, action_required, ...) extends the streak, because
# all of them mean "the canary was not healthy", which is what a human
# staring at a run of dead canaries actually cares about, not the
# fine-grained conclusion label.
if ! prior_conclusions=$(gh api "repos/$REPO/actions/workflows/$WORKFLOW_FILE/runs?status=completed&per_page=50" \
  --jq '[.workflow_runs[] | select(.id != '"$RUN_ID"') | .conclusion]' 2>&1); then
  echo "::error::Consecutive-failure count lookup (gh api repos/$REPO/actions/workflows/$WORKFLOW_FILE/runs) failed: $prior_conclusions"
  exit 1
fi

consecutive_prior=0
while IFS= read -r concl; do
  [ -z "$concl" ] && continue
  [ "$concl" = "success" ] && break
  consecutive_prior=$((consecutive_prior + 1))
done < <(jq -r '.[]' <<<"$prior_conclusions")
count=$((consecutive_prior + 1))

body="$WORKFLOW_NAME failed.

- Run: $RUN_URL
- Time (UTC): $TIMESTAMP
- Consecutive failures: $count"

if [ -n "$open_issue_num" ]; then
  if ! comment_output=$(gh issue comment "$open_issue_num" --repo "$REPO" --body "$body" 2>&1); then
    echo "::error::Failed to comment on existing alert issue #$open_issue_num: $comment_output"
    exit 1
  fi
  echo "::notice::Commented on existing alert issue #$open_issue_num ($count consecutive failure(s))."
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
echo "::notice::Created alert issue for $count consecutive failure(s): $create_output"
