#!/usr/bin/env bash
set -euo pipefail
# Re-read every open head. Fork events can lack PR numbers, and
# GitHub may coalesce queued runs in the concurrency group.
pulls=$(gh api --method GET --paginate "repos/$REPO/pulls" -f base="$BASE" -f state=open -F per_page=100 --jq '.[] | [.number, .head.sha] | @tsv')
encoded_base=$(jq -nr --arg base "$BASE" '$base | @uri')
required=$(gh api --paginate --slurp "repos/$REPO/rules/branches/$encoded_base" | jq -r '
  any(.[][] | .parameters.required_status_checks[]?;
      .context == "LCARS review (merge candidate)" and .integration_id == 4457090)')
declare -A states descriptions prs
while read -r pr head; do
  [[ -n "$pr" ]] || continue
  reviews=$(gh api --paginate --slurp "repos/$REPO/pulls/$pr/reviews?per_page=100")
  # GraphQL variables must reach GitHub literally.
  # shellcheck disable=SC2016
  comparison=$(gh api graphql -F owner="${REPO%/*}" -F repo="${REPO#*/}" -F pr="$pr" \
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
    | select([.potentialMergeCommit.parents.nodes[]?.oid] == [.baseRef.target.oid, $head])
    | .potentialMergeCommit.oid // empty' <<< "$comparison")
  [[ -n "$candidate" ]] || continue
  base_event=$(jq -c '.timelineItems.nodes[0] // {}' <<< "$comparison")
  base_tip=$(jq -r '.baseRef.target.oid' <<< "$comparison")
  merge_base=$(gh api "repos/$REPO/compare/$base_tip...$head" --jq '.merge_base_commit.sha')
  [[ "$merge_base" =~ ^[0-9a-f]{40}$ ]]
  state=$(jq -r --arg merge_base "$merge_base" --argjson base_event "$base_event" --arg head "$head" '
    def marked($marker): (.body // "" | split("\n") | any(rtrimstr("\r") == $marker));
    def base_receipt: (.body // "" | split("\n")[0] | rtrimstr("\r") |
      [capture("^<!-- lcars-review:base-event (?<id>[^[:space:]<>]+) -->$").id][0]);
    [ .[][] | select(.user.login == "agent-lcars[bot]" and .commit_id == $head)
      | select($base_event.id == null or (base_receipt == $base_event.id) or
          (.submitted_at >= $base_event.createdAt and
           (base_receipt == null) and
           (.state == "CHANGES_REQUESTED" or (.state == "COMMENTED" and marked("<!-- lcars-review:block -->"))))) ]
    | reduce .[] as $r ("pending";
        if $r.state == "CHANGES_REQUESTED" then
          if . == "blocked" or $base_event.id == null or
            ($r | (base_receipt == $base_event.id))
          then "blocked" else "provisional_block" end
        elif $r.state == "COMMENTED" and . != "blocked" and
          ($r | marked("<!-- lcars-review:block -->")) then "comment_blocked"
        elif ($r | marked("<!-- lcars-review:merge-base \($merge_base) -->")) and
          ($r.body // "" | test("<!-- attempt-claim:g[0-9]+:[^[:space:]>]+ -->")) and
          ($r.state == "APPROVED" or ($r.state == "COMMENTED" and ($r.body | split("\n") | any(rtrimstr("\r") == "<!-- lcars-review:pass -->")) and . != "blocked"))
        then "success" else . end)
  ' <<< "$reviews")
  case "$state" in
    blocked|provisional_block|comment_blocked) state=pending; description="LCARS requested changes" ;;
    pending) description="Awaiting LCARS code review; ask a maintainer to comment /review" ;;
    success) description="LCARS reviewed this commit" ;;
  esac
  # Group matching GitHub-generated merge candidates.
  # Every such PR needs its own review before the SHA can pass.
  if [[ ${states[$candidate]:-} != pending ]]; then
    states[$candidate]=$state
    descriptions[$candidate]=$description
    prs[$candidate]=$pr
  fi
done <<< "$pulls"
for candidate in "${!states[@]}"; do
  state=${states[$candidate]}
  description=${descriptions[$candidate]}
  pr=${prs[$candidate]}
  # Update the existing check so a blocking rereview revokes success.
  checks=$(gh api --paginate --slurp "repos/$REPO/commits/$candidate/check-runs?check_name=LCARS%20review%20%28merge%20candidate%29&filter=all&per_page=100")
  current=$(jq -c '[.[].check_runs[] | select(.app.id == 4457090 and .external_id == "lcars-review-merge-candidate")] | max_by(.id)' <<< "$checks")
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
