#!/usr/bin/env bash
# Sourced by direct-runner. A successful process exit is not a deliverable.
# This helper authorizes at most the caller's one same-session correction;
# provider errors, lookup failures, and terminal Work records never qualify.

# Deadlines passed here, and every run deadline the caller computes, use the
# kernel's monotonic uptime rather than bash's wall-clock $SECONDS: a node
# clock step must neither grant nor take provider time.
# DIRECT_RUNNER_UPTIME_FILE lets the test drive this clock exactly.
monotonic_seconds() {
  local uptime
  read -r uptime _ < "${DIRECT_RUNNER_UPTIME_FILE:-/proc/uptime}"
  printf '%s\n' "${uptime%%.*}"
}

# A report's final message is its deliverable (#2845). It is usable only when
# nonblank and within the Work API's completion bound, RUN_MESSAGE_MAX_BYTES
# (4 MiB of UTF-8, libs/dispatch-contracts/src/run-message.ts). The Work API
# stores a message of any size up to that bound whole, so a longer report is
# the only one refused here (earning the correction round), never truncated.
RUN_MESSAGE_MAX_BYTES="${RUN_MESSAGE_MAX_BYTES:-4194304}"
report_message_usable() {
  [ -f "${1:-}" ] || return 1
  [ "$(stat -c %s "$1")" -le "$RUN_MESSAGE_MAX_BYTES" ] || return 1
  # JavaScript's trim(), exactly as the Work API judges a blank report.
  node -e 'process.exit(require("fs").readFileSync(process.argv[1], "utf8").trim() !== "" ? 0 : 1)' "$1"
}

# The two marker lines bind a report to this attempt. Older workers wrote
# only the markers and delivered the body through the provider's final turn.
native_report_source() {
  python3 -I - "$NATIVE_WORK_OUTCOME_FILE" "$ATTEMPT_ID" "$RUN_MESSAGE_MAX_BYTES" "$RUNNER_TEMP" "$1" <<'PYTHON'
import os
import stat
import sys
import tempfile

record, attempt, limit, directory, fallback = sys.argv[1:]
header = f"<!-- agent-result:v1:report:{attempt} -->\n<!-- attempt-claim:{attempt} -->\n".encode()
try:
    fd = os.open(record, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or stream.read(len(header)) != header:
            sys.exit(1)
        body = stream.read(int(limit) + 1)
    if len(body) > int(limit):
        sys.exit(1)
    if body:
        body.decode("utf-8", errors="strict")
        with tempfile.NamedTemporaryFile(dir=directory, prefix="report-body.", delete=False) as snapshot:
            snapshot.write(body)
        print(snapshot.name)
    else:
        print(fallback)
except (OSError, UnicodeError):
    sys.exit(1)
PYTHON
}

# The optional third argument names the round's final-message file. Given
# one, a report record settles the round only with a usable message, so an
# unusable report still earns the same-session correction.
worker_completion_needed() {
  local agent_exit="$1" deadline="$2" message_file="${3:-}" remaining probe_dir probe_exit
  [ "$agent_exit" -eq 0 ] || return 1
  if worker_control_failed; then return 1; fi
  remaining=$((deadline - $(monotonic_seconds)))
  [ "$remaining" -gt 0 ] || return 1
  if [ "$ANCHOR_TYPE" = work ] && [ -f "${NATIVE_WORK_OUTCOME_FILE:-}" ]; then
    local result results=(park no-op)
    if [ "${REPORT_DELIVERABLE:-}" = 1 ] && message_file="$(native_report_source "$message_file")"; then
      if [ -z "$message_file" ] || report_message_usable "$message_file"; then
        return 1
      fi
    fi
    for result in "${results[@]}"; do
      if printf '<!-- agent-result:v1:%s:%s -->\n<!-- attempt-claim:%s -->\n' \
        "$result" "$ATTEMPT_ID" "$ATTEMPT_ID" | cmp -s - "$NATIVE_WORK_OUTCOME_FILE"; then
        return 1
      fi
    done
  fi
  probe_dir="$(mktemp -d "$RUNNER_TEMP/completion-probe.XXXXXX")" || return 1
  : > "$probe_dir/runtime.env" || return 1
  [ "$remaining" -le 60 ] || remaining=60
  probe_exit=0
  AGENT="$AGENT_NAME" REPO="$TARGET_REPO" NUM="$ISSUE" MODE="$MODE" ATTEMPT_ID="$ATTEMPT_ID" RUNTIME_ENV="$probe_dir/runtime.env" \
    timeout --signal=TERM --kill-after=5s "${remaining}s" bash "$VERIFY_OUTCOME" > "$probe_dir/result.txt" 2>&1 || probe_exit=$?
  [ "$probe_exit" -eq 1 ] &&
    grep -Fxq 'NO_DELIVERABLE=1' "$probe_dir/runtime.env" && [ $((deadline - $(monotonic_seconds))) -gt 0 ]
}

worker_authorize_correction() {
  # A new execution round requires the still-live lease, not merely a saved
  # session id. Missing authorization leaves normal finalization in charge.
  curl -sf --config - >/dev/null 2>&1 <<CURLCFG
url = "$RUNS_API/heartbeat"
request = "POST"
header = "$AUTH_HEADER"
$CURL_TIMEOUT_CONFIG
CURLCFG
}

# A verified passing review of the current head supersedes the same
# reviewer's earlier requested-changes reviews on that pull request. GitHub
# keeps a requested-changes review in force until it is dismissed, so without
# this a later pass on the same commit (or a newer one) still leaves the PR
# blocked and someone has to dismiss the outdated review by hand. Only the
# verified review's own author is affected; a human's review is never touched.
supersede_prior_reviews() {
  local repo="$1" pr="$2" review_id="$3" head reviews stale url id
  head="$(gh api "repos/$repo/pulls/$pr" --jq .head.sha)" || return 1
  reviews="$(gh api --paginate --slurp "repos/$repo/pulls/$pr/reviews?per_page=100")" || return 1
  stale="$(jq -r --argjson id "$review_id" --arg head "$head" '
    [.[][]] as $all
    | ($all | map(select(.id == $id)) | first) as $pass
    | select($pass != null and $pass.commit_id == $head and
        ($pass.state == "APPROVED" or ($pass.state == "COMMENTED" and
          (($pass.body // "") | split("\n") | map(rtrimstr("\r")) | index("<!-- lcars-review:pass -->") != null))))
    | $all[]
    | select(.state == "CHANGES_REQUESTED" and .user.login == $pass.user.login and .id < $id)
    | .id' <<< "$reviews")" || return 1
  url="$(jq -r --argjson id "$review_id" '[.[][] | select(.id == $id)][0].html_url // empty' <<< "$reviews")"
  # Attempt every stale review; one failure (say, already dismissed) must not
  # leave the rest in force.
  local failed=0
  for id in $stale; do
    if gh api --method PUT "repos/$repo/pulls/$pr/reviews/$id/dismissals" -f event=DISMISS \
      -f message="Superseded by this reviewer's passing review of $head: $url" >/dev/null; then
      echo "Dismissed superseded requested-changes review $id on $repo#$pr"
    else
      failed=1
    fi
  done
  return "$failed"
}

# Consumed by all three provider branches in the sourcing direct runner.
# shellcheck disable=SC2034
WORKER_COMPLETION_PROMPT='Continue the same authorized task in this existing session. The completed deliverable lookup found no exact attempt-bound artifact. Finish the remaining work and publish the requested marker-stamped deliverable. Use PARK only for missing access or credentials or a maintainer-reserved action (shared protocol section 4), never for a judgement call you can make yourself or for a provider, setup, timeout, or lookup failure. Preserve useful work. This is the only correction round and uses the original remaining time budget.'
