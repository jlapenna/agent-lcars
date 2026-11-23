#!/usr/bin/env bash
set -euo pipefail
# Re-read every open head. Fork events can lack PR numbers, and
# GitHub may coalesce queued runs in the concurrency group.
pulls=$(gh api --method GET --paginate "repos/$REPO/pulls" -f base="$BASE" -f state=open -F per_page=100 --jq '.[] | [.number, .head.sha] | @tsv')
encoded_base=$(jq -nr --arg base "$BASE" '$base | @uri')
rules=$(gh api --paginate --slurp "repos/$REPO/rules/branches/$encoded_base")
required=$(jq -r '
  any(.[][] | .parameters.required_status_checks[]?;
      .context == "LCARS review (merge candidate)" and .integration_id == 4457090)' <<< "$rules")
# A ruleset evaluating the update of the default branch looks for a required
# check on the pull request head. It does not find one published only on the
# test merge commit, although GitHub's auto-merge counts it there (#3473). So
# the same verdict is also published on the head as `LCARS review`, the
# context a ruleset can require.
required_head=$(jq -r '
  any(.[][] | .parameters.required_status_checks[]?;
      .context == "LCARS review" and .integration_id == 4457090)' <<< "$rules")

# publish_check COMMIT NAME EXTERNAL_ID IS_REQUIRED
# Writes the verdict in $state/$description/$conclusion/$details_url to one
# App check run on COMMIT, updating the existing run so a blocking rereview
# revokes an earlier success.
publish_check() {
  local commit=$1 name=$2 external_id=$3 is_required=$4
  local encoded_name checks current id
  encoded_name=$(jq -nr --arg name "$name" '$name | @uri')
  checks=$(gh api --paginate --slurp "repos/$REPO/commits/$commit/check-runs?check_name=$encoded_name&filter=all&per_page=100")
  current=$(jq -c --arg external_id "$external_id" \
    '[.[].check_runs[] | select(.app.id == 4457090 and .external_id == $external_id)] | max_by(.id)' <<< "$checks")
  local fields=(-f name="$name" -f details_url="$details_url"
    -f "output[title]=$description" -f "output[summary]=$description"
    -f conclusion="$conclusion")
  if [[ "$current" == null ]]; then
    # Missing required checks block merge. During staging, an optional
    # failed check would also hold unrelated Renovate updates.
    [[ "$is_required" == true || "$state" == success ]] || return 0
    GH_TOKEN="$PUBLISHER_TOKEN" gh api --method POST "repos/$REPO/check-runs" -f head_sha="$commit" -f external_id="$external_id" \
      -f status=completed "${fields[@]}" --silent
  elif ! jq -e --arg title "$description" --arg url "$details_url" --arg conclusion "$conclusion" \
    '.status == "completed" and .details_url == $url and .output.title == $title and .conclusion == $conclusion' <<< "$current" >/dev/null; then
    id=$(jq -r .id <<< "$current")
    GH_TOKEN="$PUBLISHER_TOKEN" gh api --method PATCH "repos/$REPO/check-runs/$id" -f status=completed "${fields[@]}" |
      jq -e --arg conclusion "$conclusion" ' .status == "completed" and .conclusion == $conclusion' >/dev/null
  fi
}
read_candidate() {
  # GraphQL variables must reach GitHub literally.
  # shellcheck disable=SC2016
  comparison=$(gh api graphql -f owner="${REPO%/*}" -f repo="${REPO#*/}" -F pr="$pr" \
    -f query='query($owner:String!, $repo:String!, $pr:Int!) {
      repository(owner:$owner, name:$repo) { pullRequest(number:$pr) {
        state isDraft baseRefName headRefName headRefOid baseRef { target { oid } }
        author { __typename login }
        commits(last:100) {
          totalCount
          nodes { commit { oid author { user { login } } signature { isValid wasSignedByGitHub } } }
        }
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
  state=$(jq -r --argjson base_event "$base_event" --argjson pr_meta "$comparison" \
    --arg head "$head" --arg task "$REPO#$pr" \
    --slurpfile completions <(printf '%s\n' "$completions") '
    def marked($marker): (.body // "" | split("\n") | any(rtrimstr("\r") == $marker));
    def attempt:
      [.body // "" | split("\n")[] | rtrimstr("\r") |
       capture("^<!-- attempt-claim:g[0-9]+:(?<task>[^[:space:]]+)/r(?<run>[1-9][0-9]*) -->$") |
       select(.task == $task) | .run | tonumber] | if length == 1 then first else null end;
    def automated_dependency_pass:
      ($pr_meta.isDraft == false) and
      ($pr_meta.author.__typename == "Bot") and
      ($pr_meta.author.login == "renovate" or $pr_meta.author.login == "dependabot") and
      (($pr_meta.headRefName // "" | test("^renovate/(major-)?(runner-cli-runtimes|anthropic-review-workflow)$")) | not) and
      (($pr_meta.author.login + "[bot]") as $expected_author |
        ($pr_meta.commits.totalCount >= 1 and $pr_meta.commits.totalCount <= 100) and
        (($pr_meta.commits.nodes | length) == $pr_meta.commits.totalCount) and
        any($pr_meta.commits.nodes[]; .commit.oid == $head) and
        all($pr_meta.commits.nodes[];
          .commit.author.user.login == $expected_author and
          .commit.signature.isValid == true and
          .commit.signature.wasSignedByGitHub == true));
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
    | (reduce .[] as $r ("pending";
        if $r.state == "CHANGES_REQUESTED" then "blocked"
        elif $r.state == "COMMENTED" and . != "blocked" and
          ($r | marked("<!-- lcars-review:block -->")) then "comment_blocked"
        elif $r.fresh and
          ($r.state == "APPROVED" or ($r.state == "COMMENTED" and ($r.body | split("\n") | any(rtrimstr("\r") == "<!-- lcars-review:pass -->")) and . != "blocked"))
        then "success" else . end))
    | if . == "pending" and automated_dependency_pass then "automated_pass" else . end
  ' <<< "$reviews")
  case "$state" in
    blocked|comment_blocked) state=pending; description="LCARS requested changes" ;;
    pending) description="Awaiting LCARS code review; ask a maintainer to comment /review" ;;
    automated_pass) state=success; description="Automated dependency update; CI gates merge" ;;
    success) description="LCARS reviewed this commit" ;;
  esac
}

# Verdicts read during this run, by pull request and head, so the head pass
# below does not read the same reviews again. The head is part of the key: a
# pull request can move to a new commit while this runs.
declare -A verdict_state verdict_description
declare -A candidate_heads
while read -r pr head; do
  [[ -n "$pr" ]] || continue
  read_candidate
  if [[ -n "$candidate" ]]; then
    candidate_heads[$candidate]=$head
  fi
done <<< "$pulls"

# open_pulls_at HEAD: open pull requests into the base branch at HEAD, read
# after the repository scan so membership and reviews are current.
open_pulls_at() {
  gh api --paginate --slurp "repos/$REPO/commits/$1/pulls?per_page=100" |
    jq -r --arg head "$1" --arg base "$BASE" '.[][] | select(.state == "open" and .head.sha == $head and .base.ref == $base) | .number'
}

for target in "${!candidate_heads[@]}"; do
  head=${candidate_heads[$target]}
  # PRs sharing a test merge commit necessarily share its second parent.
  matching=$(open_pulls_at "$head")
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
      verdict_state[$pr:$head]=$state
      verdict_description[$pr:$head]=$description
    fi
    selected_pr=$pr
    [[ "$state" == success ]] || break
  done <<< "$matching"
  [[ -n "$selected_pr" ]] || continue
  pr=$selected_pr
  details_url="https://github.com/$REPO/pull/$pr"
  conclusion=failure
  if [[ "$state" == success ]]; then
    conclusion=success
  fi
  publish_check "$target" "LCARS review (merge candidate)" lcars-review-merge-candidate "$required"
done

# The head check does not depend on a test merge commit: a pull request GitHub
# cannot merge yet can still be reviewed, and a blocking rereview must revoke
# an earlier success on its head. A head is shared by every pull request at
# that commit, so it passes only when each of them has its own passing review.
declare -A published_heads
while read -r _ head; do
  [[ -n "$head" && -z ${published_heads[$head]:-} ]] || continue
  published_heads[$head]=1
  matching=$(open_pulls_at "$head")
  [[ -n "$matching" ]] || continue
  selected_pr=
  while read -r pr; do
    if [[ -n ${verdict_state[$pr:$head]:-} ]]; then
      state=${verdict_state[$pr:$head]}
      description=${verdict_description[$pr:$head]}
    else
      read_candidate
      # The pull request may have moved to another head or base since the scan.
      jq -e --arg base "$BASE" --arg head "$head" \
        '.state == "OPEN" and .baseRefName == $base and .headRefOid == $head' <<< "$comparison" >/dev/null || continue
      read_verdict
    fi
    selected_pr=$pr
    [[ "$state" == success ]] || break
  done <<< "$matching"
  [[ -n "$selected_pr" ]] || continue
  pr=$selected_pr
  details_url="https://github.com/$REPO/pull/$pr"
  conclusion=failure
  if [[ "$state" == success ]]; then
    conclusion=success
  fi
  publish_check "$head" "LCARS review" lcars-review "$required_head"
done <<< "$pulls"
