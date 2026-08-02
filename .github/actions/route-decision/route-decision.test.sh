#!/usr/bin/env bash
#
# Fixture-driven coverage of route-decision.sh's full authorization/command
# matrix. Each fixture under fixtures/ is a trimmed real GitHub webhook
# payload; run_case() feeds one through the script exactly as the composite
# action would (same env var contract) and asserts the resulting
# $GITHUB_OUTPUT.

set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixtures_dir="$action_dir/fixtures"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

case_count=0

get_output() {
  # $1 = GITHUB_OUTPUT file, $2 = key
  sed -n "s/^$2=//p" "$1" | tail -n1
}

# Runs route-decision.sh against one fixture and asserts its outputs.
# Pass "SKIP" for any expected value this case doesn't care about.
run_case() {
  local name="$1" fixture="$2" event_name="$3" actor="$4" maintainer="$5"
  local expect_dispatch="$6" expect_pipeline="$7" expect_mode="$8"
  local expect_issue="$9" expect_workflow="${10}" expect_labels_to_remove="${11}"

  local event_path="$fixtures_dir/$fixture"
  test -f "$event_path" || { echo "FAIL [$name]: missing fixture $event_path" >&2; exit 1; }

  # Mirrors the "Resolve current issue labels" workflow step: the current
  # label snapshot is resolved by the caller, not by route-decision.sh.
  local labels
  labels="$(jq -r '[(.issue.labels // [])[].name] | join(",")' "$event_path")"

  local out_file="$test_root/output-$name"
  : > "$out_file"

  if ! GITHUB_EVENT_NAME="$event_name" GITHUB_EVENT_PATH="$event_path" \
       GITHUB_ACTOR="$actor" MAINTAINER_LOGIN="$maintainer" LABELS="$labels" \
       GITHUB_OUTPUT="$out_file" \
       bash "$action_dir/route-decision.sh" > "$test_root/log-$name" 2>&1
  then
    echo "FAIL [$name]: route-decision.sh exited non-zero" >&2
    cat "$test_root/log-$name" >&2
    exit 1
  fi

  local field expected actual
  for field in dispatch pipeline mode issue workflow labels-to-remove; do
    case "$field" in
      dispatch) expected="$expect_dispatch" ;;
      pipeline) expected="$expect_pipeline" ;;
      mode) expected="$expect_mode" ;;
      issue) expected="$expect_issue" ;;
      workflow) expected="$expect_workflow" ;;
      labels-to-remove) expected="$expect_labels_to_remove" ;;
    esac
    [ "$expected" = "SKIP" ] && continue
    actual="$(get_output "$out_file" "$field")"
    if [ "$actual" != "$expected" ]; then
      echo "FAIL [$name]: $field = '$actual', expected '$expected'" >&2
      exit 1
    fi
  done

  case_count=$((case_count + 1))
  echo "PASS [$name]"
}

#         name                                     fixture                                                   event           actor            maintainer       dispatch pipeline   mode        issue  workflow        labels-to-remove

# Each agent:* label routes to its own pipeline.
run_case label-routes-claude                       issues-labeled-claude.json                                issues          maintainer-bot   maintainer-bot   true     claude     implement   101    claude.yml      ""
run_case label-routes-codex                         issues-labeled-codex.json                                 issues          maintainer-bot   maintainer-bot   true     codex      implement   102    codex.yml       ""
run_case label-routes-opencode                      issues-labeled-opencode.json                              issues          maintainer-bot   maintainer-bot   true     opencode   implement   103    opencode.yml    ""

# A non-agent label never dispatches, even from the maintainer.
run_case label-non-agent-no-dispatch                issues-labeled-non-agent.json                             issues          maintainer-bot   maintainer-bot   false    ""         implement   104    ""              ""

# Only the configured maintainer can route by labeling.
run_case label-unauthorized-actor-no-dispatch        issues-labeled-claude.json                                issues          someone-else     maintainer-bot   false    ""         implement   101    ""              ""

# Defensive: an unset MAINTAINER_LOGIN must never authorize via "" == "".
run_case label-empty-maintainer-no-dispatch          issues-labeled-claude.json                                issues          ""               ""               false    ""         implement   101    ""              ""

# Routing strips competing agent:* labels and stale status:* labels.
run_case label-routes-and-strips-competing-labels    issues-labeled-competing-labels.json                     issues          maintainer-bot   maintainer-bot   true     codex      implement   105    codex.yml       "agent:claude,status:ready-for-agent,status:needs-human"

# issues event with the wrong action (defensive; the on: trigger already
# restricts to 'labeled', but the script re-validates independently).
run_case label-wrong-action-no-dispatch              issues-wrong-action.json                                  issues          maintainer-bot   maintainer-bot   false    ""         implement   106    ""              ""

# Each owner comment command routes, provided the matching agent:* label
# is already on the issue (or, for @claude, the anchor is a PR).
run_case comment-claude-command                     issue-comment-claude-command.json                         issue_comment   maintainer-bot   maintainer-bot   true     claude     reply       201    claude.yml      ""
run_case comment-claude-on-pr-bypasses-label         issue-comment-claude-on-pr-no-label.json                  issue_comment   maintainer-bot   maintainer-bot   true     claude     reply       202    claude.yml      ""
run_case comment-claude-no-label-not-pr-no-dispatch  issue-comment-claude-no-label-not-pr.json                 issue_comment   maintainer-bot   maintainer-bot   false    ""         implement   203    ""              ""
run_case comment-codex-command                      issue-comment-codex-command.json                          issue_comment   maintainer-bot   maintainer-bot   true     codex      reply       210    codex.yml       ""
run_case comment-codex-missing-label-no-dispatch     issue-comment-codex-missing-label.json                    issue_comment   maintainer-bot   maintainer-bot   false    ""         implement   211    ""              ""
run_case comment-opencode-full-command               issue-comment-opencode-full-command.json                  issue_comment   maintainer-bot   maintainer-bot   true     opencode   reply       220    opencode.yml    ""
run_case comment-opencode-short-command              issue-comment-opencode-short-command.json                 issue_comment   maintainer-bot   maintainer-bot   true     opencode   reply       221    opencode.yml    ""
run_case comment-opencode-short-command-midtext      issue-comment-opencode-short-command-midtext.json         issue_comment   maintainer-bot   maintainer-bot   true     opencode   reply       222    opencode.yml    ""

# Word-boundary fix: "/oc" must not substring-match inside another word or
# a URL path segment. These would have false-positived before the fix.
run_case comment-opencode-octopus-negative           issue-comment-opencode-octopus-negative.json              issue_comment   maintainer-bot   maintainer-bot   false    ""         implement   223    ""              ""
run_case comment-opencode-url-negative                issue-comment-opencode-url-negative.json                 issue_comment   maintainer-bot   maintainer-bot   false    ""         implement   224    ""              ""

# Bot-authored comments and non-owner comments never dispatch.
run_case comment-bot-authored-no-dispatch            issue-comment-bot.json                                    issue_comment   maintainer-bot   maintainer-bot   false    ""         implement   230    ""              ""
run_case comment-non-owner-no-dispatch               issue-comment-non-owner.json                              issue_comment   maintainer-bot   maintainer-bot   false    ""         implement   231    ""              ""

# No recognized command in the comment body.
run_case comment-no-command-no-dispatch              issue-comment-no-command.json                             issue_comment   maintainer-bot   maintainer-bot   false    ""         implement   232    ""              ""

# issue_comment event with the wrong action (defensive; on: already
# restricts to 'created').
run_case comment-wrong-action-no-dispatch            issue-comment-wrong-action.json                           issue_comment   maintainer-bot   maintainer-bot   false    ""         implement   233    ""              ""

# workflow_dispatch passes its inputs straight through.
run_case workflow-dispatch-passthrough               workflow-dispatch-basic.json                              workflow_dispatch maintainer-bot maintainer-bot   true     codex      reply       401    codex.yml       ""
run_case workflow-dispatch-defaults-mode             workflow-dispatch-default-mode.json                       workflow_dispatch maintainer-bot maintainer-bot   true     claude     implement   402    claude.yml      ""
run_case workflow-dispatch-missing-inputs-no-dispatch workflow-dispatch-missing-inputs.json                    workflow_dispatch maintainer-bot maintainer-bot   false    ""         implement   ""     ""              ""

# Any other event name falls through to no-match.
run_case unsupported-event-no-dispatch               unsupported-event.json                                    pull_request    maintainer-bot   maintainer-bot   false    ""         implement   ""     ""              ""

# GITHUB_EVENT_PATH must fail loud, not silently proceed, when missing.
missing_event_path="$test_root/does-not-exist.json"
missing_out="$test_root/output-missing-event-path"
: > "$missing_out"
if GITHUB_EVENT_NAME=issues GITHUB_EVENT_PATH="$missing_event_path" \
   MAINTAINER_LOGIN=maintainer-bot GITHUB_OUTPUT="$missing_out" \
   bash "$action_dir/route-decision.sh" > "$test_root/log-missing-event-path" 2>&1
then
  echo "FAIL [missing-event-path]: expected non-zero exit for a missing GITHUB_EVENT_PATH" >&2
  exit 1
fi
echo "PASS [missing-event-path]"
case_count=$((case_count + 1))

echo "route-decision.test.sh: $case_count cases passed"
