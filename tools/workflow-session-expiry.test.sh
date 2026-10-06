#!/usr/bin/env bash
# The session-expiry workflow must be event-driven (workflow_dispatch only,
# no schedule), request write on id-token only, mint a bearer for the
# session-expiry audience, impersonate the telemetry writer as an access
# token, and invoke the expiry script with the dispatched item. The retired
# 30-minute pin tick must stay gone. Pure text assertions on the YAML -- no
# git, no GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
f=.github/workflows/work-session-expiry.yml
[ -f "$f" ] || { echo "$f: missing"; exit 1; }
[ ! -e .github/workflows/work-session-pin-tick.yml ] || { echo "work-session-pin-tick.yml: the retired poll is back"; fail=1; }
grep -q 'workflow_dispatch:' "$f" || { echo "$f: missing workflow_dispatch trigger"; fail=1; }
! grep -qE '^\s*(schedule|cron):' "$f" || { echo "$f: must not poll on a schedule; the console dispatches it on item close"; fail=1; }
grep -q 'id-token: write' "$f" || { echo "$f: missing id-token: write permission"; fail=1; }
# Assert the FULL permissions block: every "*: write" line must be id-token's.
perm_block="$(awk '/^permissions:/{f=1;next} f&&/^[a-zA-Z]/{exit} f{print}' "$f")"
[ -n "$perm_block" ] || { echo "$f: missing permissions: block"; fail=1; }
all_writes="$(grep -c ': write' <<<"$perm_block" || true)"
id_token_writes="$(grep -c '^ *id-token: write$' <<<"$perm_block" || true)"
[ "$all_writes" -eq "$id_token_writes" ] && [ "$id_token_writes" -ge 1 ] || {
  echo "$f: permissions block must grant write on id-token only, got:"
  echo "$perm_block"
  fail=1
}
grep -q 'audience=agent-lcars-session-expiry' "$f" || { echo "$f: wrong or missing read audience"; fail=1; }
grep -q 'token_format: access_token' "$f" || { echo "$f: missing write token_format: access_token"; fail=1; }
grep -q 'SESSION_EXPIRY_ITEM: \${{ inputs.item }}' "$f" || { echo "$f: dispatched item is not passed to the script"; fail=1; }
grep -q 'bin/session-expiry.ts' "$f" || { echo "$f: missing script invocation"; fail=1; }
# The console dispatches this exact file name.
grep -q "SESSION_EXPIRY_WORKFLOW_FILE = 'work-session-expiry.yml'" apps/console/src/lib/github-actions-oidc.ts || { echo "console dispatch/OIDC target does not name $f"; fail=1; }
exit $fail
