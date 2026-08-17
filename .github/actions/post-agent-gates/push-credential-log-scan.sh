#!/usr/bin/env bash
# codex.yml/opencode.yml-specific "Determine failure reason" signal, kept as
# an adapter-style input to the shared post-agent-gates.sh orchestrator
# rather than baking it into the shared script (mirrors claude-log-scan.sh's
# own rationale). Only codex.yml/opencode.yml point FAILURE_LOG_SCAN_SCRIPT
# at this file - claude.yml's push credential is managed internally by
# claude-code-action, so this signature cannot occur there (agent-lcars#1217).
#
# The App installation token dispatch-bootstrap mints - the only credential
# these two lanes' raw `git push`/`gh` calls have - expires 3600s after
# mint. #1226 already bounded each lane's agent step inside that window, but
# the step still starts a couple of minutes after the mint, so a push issued
# in the step's last stretch can still race the token's expiry. When that
# happens the failure is opaque: git falls back to prompting for a username,
# finds no tty, and fails with an error that reads like a *missing*
# credential rather than an expired one:
#
#   fatal: could not read Username for 'https://github.com': No such device
#   or address
#
# This scans the run log for that signature (and the sibling shapes the
# same expiry can surface as, depending on which command the agent last
# used to push) and, if found, supplements the failure report with a
# legible explanation instead of leaving the opaque git text to speak for
# itself. Prints extra REASON text (already newline-prefixed, matching
# every other REASON value in this repo) to stdout, or nothing if no
# signature matches. post-agent-gates.sh only invokes this when
# NO_DELIVERABLE was NOT set, mirroring claude-log-scan.sh's own ordering.
set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RUN_ID:?RUN_ID is required}"

LOG="$(gh run view "$RUN_ID" --log 2>/dev/null || true)"
if [ -z "$LOG" ]; then
  echo "::warning::This in-progress run's log was unavailable; the push-credential-expiry check was skipped." >&2
  exit 0
fi

if echo "$LOG" | grep -Eqi \
  "could not read Username for 'https://github.com'|Support for password authentication was removed|remote: Invalid username or token|fatal: Authentication failed for 'https://github.com"; then
  printf '%s' $'\n\nA `git`/`gh` push or API call failed with an authentication error. This is very likely the GitHub App installation token expiring mid-step, not a missing credential: the token dispatch-bootstrap mints lives for only 60 minutes and nothing refreshes it once the agent step starts (agent-lcars#1217). Any work committed but not yet pushed before that point did not land. Re-dispatch to retry from a fresh token.'
fi
