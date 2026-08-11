#!/usr/bin/env bash
# Watch armed PRs until every one merges or any one needs attention.
#
# The single-run monitor (monitor.cjs) answers "did this CI run pass?";
# this script answers the auto-merge lifecycle question an agent session
# actually has after `gh pr merge --auto`: "did my PRs land, and if not,
# what do I need to fix?" It polls each PR and exits the moment anything
# needs a human/agent (a DIRTY merge state, a failed check, a close
# without merge) — or with success once every watched PR has merged.
#
# Designed to run as a BACKGROUND task in an agent session: the exit
# re-invokes the agent with the verdict on stdout, so nothing sits
# unnoticed. Failure detection matters most — an armed PR whose Verify
# fails will otherwise wait silently forever (auto-merge never fires and
# nothing pings the session; this exact gap cost hours on #4211/#4230).
#
# Usage:
#   watch-prs.sh [--interval <seconds>] <pr-number> [<pr-number>...]
#
# Output: one timestamped line per state change, then a final verdict:
#   VERDICT ALL-MERGED                          (exit 0)
#   VERDICT ATTENTION <pr> <reason>             (exit 2)
# Reasons: dirty (needs rebase), checks-failed:<names>, closed-unmerged.
#
# Requires: gh (authenticated). Poll cost is two `gh` calls per PR per
# interval; the default 120s keeps that well inside rate limits.

set -euo pipefail

interval=120
prs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --interval)
      interval="$2"
      shift 2
      ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 1
      ;;
    *)
      prs+=("$1")
      shift
      ;;
  esac
done

if [ ${#prs[@]} -eq 0 ]; then
  echo "usage: watch-prs.sh [--interval <seconds>] <pr-number> [<pr-number>...]" >&2
  exit 1
fi

declare -A merged=()
declare -A last=()

log() {
  echo "$(date -u +%H:%M:%S) $*"
}

while true; do
  all_merged=true
  for pr in "${prs[@]}"; do
    [ "${merged[$pr]:-}" = "1" ] && continue

    if ! status=$(gh pr view "$pr" --json state,mergeStateStatus \
      --jq '.state + ":" + .mergeStateStatus' 2>/dev/null); then
      # Transient gh/network error: report once, keep watching.
      all_merged=false
      [ "${last[$pr]:-}" != "gh-error" ] && log "PR #$pr: gh lookup failed (will retry)"
      last[$pr]="gh-error"
      continue
    fi

    state="${status%%:*}"

    case "$state" in
      MERGED)
        merged[$pr]=1
        log "PR #$pr: MERGED"
        continue
        ;;
      CLOSED)
        log "PR #$pr: closed without merging"
        echo "VERDICT ATTENTION $pr closed-unmerged"
        exit 2
        ;;
    esac
    all_merged=false

    if [ "$status" != "${last[$pr]:-}" ]; then
      log "PR #$pr: $status"
      last[$pr]="$status"
    fi

    case "$status" in
      *DIRTY*)
        echo "VERDICT ATTENTION $pr dirty"
        exit 2
        ;;
    esac

    # `gh pr checks` exits non-zero while checks are pending or failed;
    # we only care about the fail rows it prints.
    failed=$(gh pr checks "$pr" 2>/dev/null |
      awk -F'\t' '$2 == "fail" { print $1 }' | paste -sd, - || true)
    if [ -n "$failed" ]; then
      log "PR #$pr: failed checks: $failed"
      echo "VERDICT ATTENTION $pr checks-failed:$failed"
      exit 2
    fi
  done

  if $all_merged; then
    echo "VERDICT ALL-MERGED"
    exit 0
  fi
  sleep "$interval"
done
