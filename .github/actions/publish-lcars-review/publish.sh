#!/usr/bin/env bash
set -euo pipefail
# Re-read every open head. Fork events can lack PR numbers, and
# GitHub may coalesce queued runs in the concurrency group.
pulls=$(gh api --method GET --paginate "repos/$REPO/pulls" -f base="$BASE" -f state=open -F per_page=100 --jq '.[] | [.number, .head.sha] | @tsv')
encoded_base=$(jq -nr --arg base "$BASE" '$base | @uri')
required=$(gh api --paginate --slurp "repos/$REPO/rules/branches/$encoded_base" | jq -r '
  any(.[][] | .parameters.required_status_checks[]?;
      .context == "LCARS review (merge candidate)" and .integration_id == 4457090)')
read_candidate() {
  # GraphQL variables must reach GitHub literally.
  # shellcheck disable=SC2016
  comparison=$(gh api graphql -f owner="${REPO%/*}" -f repo="${REPO#*/}" -F pr="$pr" \
    -f query='query($owner:String!, $repo:String!, $pr:Int!) {
      repository(owner:$owner, name:$repo) { pullRequest(number:$pr) {
        state baseRefName headRefOid baseRef { target { oid } }
        potentialMergeCommit { oid parents(first:2) { nodes { oid } } }
        timelineItems(last:1, itemTypes:[BASE_REF_CHANGED_EVENT]) {
          nodes { ... on BaseRefChangedEvent { id createdAt } }
        }
      } }
    }' --jq '.data.repository.pullRequest')
  candidate=$(jq -r --arg base "$BASE" --arg head "$head" '
    select(.state == "OPEN" and .baseRefName == $base and .headRefOid == $head)
    | select((.potentialMergeCommit.parents.nodes | length) == 2 and .potentialMergeCommit.parents.nodes[1].oid == $head)
    | .potentialMergeCommit.oid // empty' <<< "$comparison")
  # Loose branch protection can retain a merge ref based on an earlier base tip.
  if [[ -n "$candidate" ]] && ! jq -e '.potentialMergeCommit.parents.nodes[0].oid == .baseRef.target.oid' <<< "$comparison" >/dev/null; then
    local response
    if response=$(gh api --include "repos/$REPO/git/ref/pull/$pr/merge" --jq '.object.sha'); then
      [[ "$candidate" == "${response##*$'\n'}" ]] || candidate=
    elif [[ "$response" =~ ^HTTP/[^[:space:]]+[[:space:]]404[[:space:]] ]]; then
      candidate=
    else
      return 1
    fi
  fi
}

read_verdict() {
  base_event=$(jq -c '.timelineItems.nodes[0] // {}' <<< "$comparison")
  reviews=$(gh api --paginate --slurp "repos/$REPO/pulls/$pr/reviews?per_page=100")
  # After a retarget, a review already in flight can still land on this
  # head. A later run on the same LCARS task starts after its predecessor
  # settles. Use the controller's completion of a post-retarget review as
  # the boundary; ordinary /review then works without a new reviewer image.
  local completions='[]'
  if [[ "$base_event" != '{}' ]]; then
    completions=$(gh api --paginate --slurp "repos/$REPO/issues/$pr/comments?per_page=100" |
      jq -c --arg prefix "✅ Run $REPO#$pr/r" '[.[][] |
        select(.user.login == "agent-lcars[bot]" and ((.body // "") | startswith($prefix))) |
        {lines: (.body | split("\n")[:2]), created_at}]')
  fi
  state=$(jq -r --argjson base_event "$base_event" --arg head "$head" --arg task "$REPO#$pr" \
    --slurpfile completions <(printf '%s\n' "$completions") '
    def marked($marker): (.body // "" | split("\n") | any(rtrimstr("\r") == $marker));
    def attempt:
      [.body // "" | split("\n")[] | rtrimstr("\r") |
       capture("^<!-- attempt-claim:g[0-9]+:(?<task>[^[:space:]]+)/r(?<run>[1-9][0-9]*) -->$") |
       select(.task == $task) | .run | tonumber] | if length == 1 then first else null end;
    [.[][] | select(.user.login == "agent-lcars[bot]") | . + {run: attempt}] as $reviews
    | [if $base_event.id != null then
         $reviews[] | select(.run != null and .submitted_at > $base_event.createdAt) as $review |
         $completions[0][] | select(.created_at >= $review.submitted_at and
           (.lines == [
             ("✅ Run " + $task + "/r" + ($review.run|tostring) + " finished."),
             $review.html_url])) | {run:$review.run, at:.created_at}
       else empty end] as $finished
    | [$reviews[] | select(.commit_id == $head) |
       . as $review | . + {fresh: (.run != null and
         ($base_event.id == null or any($finished[]; .run < $review.run and .at < $review.submitted_at)))}]
    | reduce .[] as $r ("pending";
        if $r.state == "CHANGES_REQUESTED" then "blocked"
        elif $r.state == "COMMENTED" and . != "blocked" and
          ($r | marked("<!-- lcars-review:block -->")) then "comment_blocked"
        elif $r.fresh and
          ($r.state == "APPROVED" or ($r.state == "COMMENTED" and ($r.body | split("\n") | any(rtrimstr("\r") == "<!-- lcars-review:pass -->")) and . != "blocked"))
        then "success" else . end)
  ' <<< "$reviews")
  case "$state" in
    blocked|comment_blocked) state=pending; description="LCARS requested changes" ;;
    pending) description="Awaiting LCARS code review; ask a maintainer to comment /review" ;;
    success) description="LCARS reviewed this commit" ;;
  esac
}

declare -A candidate_heads
while read -r pr head; do
  [[ -n "$pr" ]] || continue
  read_candidate
  if [[ -n "$candidate" ]]; then
    candidate_heads[$candidate]=$head
  fi
done <<< "$pulls"
for target in "${!candidate_heads[@]}"; do
  head=${candidate_heads[$target]}
  candidate=$target
  # Update the existing check so a blocking rereview revokes success.
  checks=$(gh api --paginate --slurp "repos/$REPO/commits/$candidate/check-runs?check_name=LCARS%20review%20%28merge%20candidate%29&filter=all&per_page=100")
  current=$(jq -c '[.[].check_runs[] | select(.app.id == 4457090 and .external_id == "lcars-review-merge-candidate")] | max_by(.id)' <<< "$checks")
  # Refresh membership and all applicable reviews after the repository scan.
  # PRs sharing a test merge commit necessarily share its second parent.
  matching=$(gh api --paginate --slurp "repos/$REPO/commits/$head/pulls?per_page=100" |
    jq -r --arg head "$head" --arg base "$BASE" '.[][] | select(.state == "open" and .head.sha == $head and .base.ref == $base) | .number')
  [[ -n "$matching" ]] || continue
  selected_pr=
  while read -r pr; do
    read_candidate
    if [[ -n "$candidate" && "$candidate" != "$target" ]]; then
      continue
    elif [[ -z "$candidate" ]]; then
      # Mergeability may still be computing for a PR with identical parents.
      state=pending
      description="Awaiting GitHub merge candidate"
    else
      read_verdict
    fi
    selected_pr=$pr
    [[ "$state" == success ]] || break
  done <<< "$matching"
  [[ -n "$selected_pr" ]] || continue
  pr=$selected_pr
  candidate=$target
  details_url="https://github.com/$REPO/pull/$pr"
  fields=(-f name="LCARS review (merge candidate)" -f details_url="$details_url"
    -f "output[title]=$description" -f "output[summary]=$description")
  check_status=completed
  conclusion=failure
  if [[ "$state" == success ]]; then
    conclusion=success
  fi
  fields+=(-f conclusion="$conclusion")
  if [[ "$current" == null ]]; then
    # Missing required checks block merge. During staging, an optional
    # failed check would also hold unrelated Renovate updates.
    [[ "$required" == true || "$state" == success ]] || continue
    GH_TOKEN="$PUBLISHER_TOKEN" gh api --method POST "repos/$REPO/check-runs" -f head_sha="$candidate" -f external_id=lcars-review-merge-candidate \
      -f status="$check_status" "${fields[@]}" --silent
  elif ! jq -e --arg status "$check_status" --arg title "$description" --arg url "$details_url" --arg conclusion "$conclusion" \
    '.status == $status and .details_url == $url and .output.title == $title and .conclusion == $conclusion' <<< "$current" >/dev/null; then
    id=$(jq -r .id <<< "$current")
    GH_TOKEN="$PUBLISHER_TOKEN" gh api --method PATCH "repos/$REPO/check-runs/$id" -f status="$check_status" "${fields[@]}" |
      jq -e --arg conclusion "$conclusion" ' .status == "completed" and .conclusion == $conclusion' >/dev/null
  fi
done
