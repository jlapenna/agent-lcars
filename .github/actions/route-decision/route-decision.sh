#!/usr/bin/env bash
#
# Single source of truth for the agent router's authorization/command
# matrix. Reads the triggering event from $GITHUB_EVENT_PATH (the real
# webhook payload on a live run; a fixture file in tests) plus
# $GITHUB_EVENT_NAME and $GITHUB_ACTOR, both of which GitHub Actions sets
# automatically for every job. MAINTAINER_LOGIN and LABELS come in as env
# vars from the composite action's inputs.
#
# Decision matrix (see route-decision.test.sh for the fixture coverage):
#
#   issues/labeled:
#     authorized when actor == MAINTAINER_LOGIN and the label starts with
#     "agent:". pipeline = label with the "agent:" prefix stripped;
#     mode = implement.
#
#   issue_comment/created:
#     authorized when the comment is not from a Bot and its
#     author_association == OWNER. Then, in order:
#       - body contains "@claude" AND (issue already has label
#         agent:claude OR the anchor is a pull request) -> claude
#       - body contains "/codex" AND issue has label agent:codex -> codex
#       - body contains "/opencode", OR "/oc" bounded by non-word
#         characters (fixes the old substring bug: "/octocat" or a "/oc"
#         URL path segment must NOT match), AND issue has label
#         agent:opencode -> opencode
#     mode = reply for all three.
#
#   workflow_dispatch:
#     authorized when inputs.issue and inputs.pipeline are both set.
#     pipeline = inputs.pipeline; mode = inputs.mode, default implement.
#
#   Any other case (wrong action, unsupported label/pipeline, no matching
#   comment command, etc.): dispatch=false.
#
# On a routed issues/issue_comment dispatch, labels-to-remove lists the
# other two agent:* labels (if present) plus any stale status:ready-for-
# agent / status:needs-human labels, so the caller can strip them exactly
# as the old inline bash did via its select_agent() helper. workflow_dispatch
# never mutates labels, matching today's behavior.

set -euo pipefail

: "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required}"
: "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

if [ ! -f "$GITHUB_EVENT_PATH" ]; then
  echo "::error::Event payload not found at GITHUB_EVENT_PATH=$GITHUB_EVENT_PATH" >&2
  exit 1
fi

ACTOR="${GITHUB_ACTOR:-}"
MAINTAINER_LOGIN="${MAINTAINER_LOGIN:-}"
LABELS="${LABELS:-}"

event_action=$(jq -r '.action // ""' "$GITHUB_EVENT_PATH")
label_name=$(jq -r '.label.name // ""' "$GITHUB_EVENT_PATH")
issue_number=$(jq -r '.issue.number // "" | tostring' "$GITHUB_EVENT_PATH")
issue_is_pr=$(jq -r 'if .issue.pull_request then "true" else "false" end' "$GITHUB_EVENT_PATH")
comment_body=$(jq -r '.comment.body // ""' "$GITHUB_EVENT_PATH")
comment_user_type=$(jq -r '.comment.user.type // ""' "$GITHUB_EVENT_PATH")
comment_author_assoc=$(jq -r '.comment.author_association // ""' "$GITHUB_EVENT_PATH")
input_issue=$(jq -r '.inputs.issue // "" | tostring' "$GITHUB_EVENT_PATH")
input_pipeline=$(jq -r '.inputs.pipeline // ""' "$GITHUB_EVENT_PATH")
input_mode=$(jq -r '.inputs.mode // ""' "$GITHUB_EVENT_PATH")

dispatch="false"
pipeline=""
mode="implement"
issue="$issue_number"
labels_to_remove=""
reason="Unsupported event $GITHUB_EVENT_NAME."

has_label() {
  [[ ",${LABELS}," == *",$1,"* ]]
}

# Mirrors the old inline select_agent(): strip the two other agent:*
# labels (if present) and any stale status labels.
compute_labels_to_remove() {
  local selected="agent:$1"
  local remove=()
  local agent_label
  for agent_label in agent:claude agent:codex agent:opencode; do
    if [[ "$agent_label" != "$selected" ]] && has_label "$agent_label"; then
      remove+=("$agent_label")
    fi
  done
  local stale_status
  for stale_status in status:ready-for-agent status:needs-human; do
    if has_label "$stale_status"; then
      remove+=("$stale_status")
    fi
  done
  local IFS=,
  labels_to_remove="${remove[*]}"
}

case "$GITHUB_EVENT_NAME" in
  issues)
    if [[ "$event_action" != "labeled" ]]; then
      reason="Issue event action '$event_action' is not 'labeled'."
    elif [[ "$ACTOR" != "$MAINTAINER_LOGIN" || -z "$MAINTAINER_LOGIN" ]]; then
      reason="Actor '$ACTOR' is not the authorized maintainer."
    elif [[ "$label_name" != agent:* ]]; then
      reason="Label '$label_name' does not start with 'agent:'."
    else
      pipeline="${label_name#agent:}"
      mode="implement"
      dispatch="true"
      compute_labels_to_remove "$pipeline"
    fi
    ;;

  issue_comment)
    if [[ "$event_action" != "created" ]]; then
      reason="Comment event action '$event_action' is not 'created'."
    elif [[ "$comment_user_type" == "Bot" || "$comment_author_assoc" != "OWNER" ]]; then
      reason="Comment is not from the repository owner."
    elif [[ "$comment_body" == *"@claude"* ]] &&
         { has_label agent:claude || [[ "$issue_is_pr" == "true" ]]; }; then
      pipeline="claude"
      mode="reply"
      dispatch="true"
      compute_labels_to_remove claude
    elif [[ "$comment_body" == *"/codex"* ]] && has_label agent:codex; then
      pipeline="codex"
      mode="reply"
      dispatch="true"
      compute_labels_to_remove codex
    elif { [[ "$comment_body" == *"/opencode"* ]] ||
           [[ "$comment_body" =~ (^|[^[:alnum:]_])/oc([^[:alnum:]_]|$) ]]; } &&
         has_label agent:opencode; then
      pipeline="opencode"
      mode="reply"
      dispatch="true"
      compute_labels_to_remove opencode
    else
      reason="Comment has no authorized agent command."
    fi
    ;;

  workflow_dispatch)
    if [[ -n "$input_issue" && -n "$input_pipeline" ]]; then
      issue="$input_issue"
      pipeline="$input_pipeline"
      mode="${input_mode:-implement}"
      dispatch="true"
    else
      reason="workflow_dispatch is missing the issue or pipeline input."
    fi
    ;;

  *)
    reason="Unsupported event $GITHUB_EVENT_NAME."
    ;;
esac

workflow=""
if [[ "$dispatch" == "true" ]]; then
  case "$pipeline" in
    claude) workflow="claude.yml" ;;
    codex) workflow="codex.yml" ;;
    opencode) workflow="opencode.yml" ;;
    *)
      dispatch="false"
      reason="Unsupported pipeline '$pipeline'."
      labels_to_remove=""
      ;;
  esac
fi

if [[ "$dispatch" == "true" ]]; then
  reason="Dispatching $workflow for issue #$issue."
fi
echo "$reason"

{
  echo "dispatch=$dispatch"
  echo "pipeline=$pipeline"
  echo "mode=$mode"
  echo "issue=$issue"
  echo "workflow=$workflow"
  echo "labels-to-remove=$labels_to_remove"
  echo "reason=$reason"
} >> "$GITHUB_OUTPUT"
