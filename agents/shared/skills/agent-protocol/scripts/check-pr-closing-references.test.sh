#!/usr/bin/env bash
# Gate contract test for the published closing-scope publication sequence
# (jlapenna/agent-lcars#2534).
#
# On #2324 publication an operator shell sequence joined the read-only
# closing-reference checker and `gh pr ready` as separate statements without
# errexit; the checker exited 1 on an unexpected closing reference and the
# ready mutation ran anyway. These tests execute the ACTUAL published
# checker (agents/shared/skills/agent-protocol/scripts/
# check-pr-closing-references.mjs), in the exact `&&`-chained fail-fast form
# shipped in the shared protocol §6 and this repo's PR workflow reference,
# against a stubbed gh so no real pull request is read or toggled:
#
#   - intentionally wrong declared scope -> the checker rejects, and the
#     harmless owned next-step witness is NOT invoked;
#   - valid declared scope -> the checker passes and the SAME witness runs;
#   - a changed head mid-publication -> the checker rejects and the witness
#     is NOT invoked.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checker="$root/scripts/check-pr-closing-references.mjs"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

head_sha=$(printf 'a%.0s' {1..40})
readonly head_sha

# Stub gh: answers the closing-reference GraphQL query with the JSON body in
# $FAKE_RESPONSE and records that it ran. Only GitHub reads are stubbed; the
# witness below is the sole mutation stand-in, so no real PR is touched.
fake_bin="$temp_dir/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
printf '%s\n' stubbed > "$FAKE_GH_CALLS"
cat "$FAKE_RESPONSE"
FAKE_GH
chmod +x "$fake_bin/gh"
export PATH="$fake_bin:$PATH"

pr_response() {
  # $1: closing issue number to report, 0 for none; $2: head to report
  local number=$1 ref_head=$2
  local nodes='[]'
  if ((number > 0)); then
    nodes="[{\"number\": $number, \"repository\": {\"nameWithOwner\": \"jlapenna/agent-lcars\"}}]"
  fi
  printf '{"data":{"repository":{"pullRequest":{"state":"OPEN","isDraft":false,"headRefOid":"%s","closingIssuesReferences":{"nodes":%s,"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}' \
    "$ref_head" "$nodes"
}

# run_chained <response-json> <declared-scope> <head>
# Reproduces the shipped fail-fast sequence: the actual read-only guard && a
# harmless owned next-step witness (a file write, never gh pr ready/merge).
run_chained() {
  local response=$1 declared=$2 at_head=$3
  export FAKE_GH_CALLS="$temp_dir/gh-calls.$RANDOM$$"
  export FAKE_RESPONSE="$temp_dir/response.json"
  printf '%s' "$response" > "$FAKE_RESPONSE"
  local chained_out status=0
  chained_out="$(
    bash -c '
      node "$1" jlapenna/agent-lcars 2324 "$3" "$2" \
        && printf ran > "$4"
    ' _ "$checker" "$declared" "$at_head" "$temp_dir/witness" 2>&1
  )" || status=$?
  CHAINED_STATUS=$status
  CHAINED_OUT=$chained_out
}

failures=0
check() { # check <description> <condition-command> [args...]
  local description=$1
  shift
  if "$@"; then
    echo "ok: $description"
  else
    echo "FAILED: $description" >&2
    failures=$((failures + 1))
  fi
}

witness_exists() { [[ -e "$temp_dir/witness" ]]; }
witness_absent() { [[ ! -e "$temp_dir/witness" ]]; }
gh_was_read() { [[ -e "$FAKE_GH_CALLS" ]]; }

# --- negative branch: the incident shape, reproduced hermetically ------------
# GitHub still returns jlapenna/agent-lcars#2407 while the operator declares
# scope none; the published guard rejects and the chained witness never runs.
run_chained "$(pr_response 2407 "$head_sha")" none "$head_sha"
check 'wrong scope: the actual checker exits nonzero' test "$CHAINED_STATUS" -ne 0
check 'wrong scope: the rejection names the unintended reference' \
  grep -q 'Closing scope mismatch: unintended \[jlapenna/agent-lcars#2407\]' <<<"$CHAINED_OUT"
check 'wrong scope: GitHub was actually read (this is the real guard, not a stub of it)' gh_was_read
check 'wrong scope: the next-step witness was NOT invoked' witness_absent
printf 'negative-branch diagnosis: %s\n' "$CHAINED_OUT"

# --- positive branch: the valid declared scope lets the SAME witness run ----
run_chained "$(pr_response 2407 "$head_sha")" jlapenna/agent-lcars#2407 "$head_sha"
check 'valid scope: the actual checker exits zero' test "$CHAINED_STATUS" -eq 0
check 'valid scope: the checker readback carries the accepted scope' \
  grep -q '"closingIssuesReferences":\["jlapenna/agent-lcars#2407"\]' <<<"$CHAINED_OUT"
check 'valid scope: the same witness DID run' witness_exists
rm -f "$temp_dir/witness"

# --- a changed head is an incomplete read: the chain still refuses ----------
run_chained "$(pr_response 0 b)" none "$head_sha"
check 'changed head: the actual checker exits nonzero' test "$CHAINED_STATUS" -ne 0
check 'changed head: the rejection names the expected head' \
  grep -q 'expected head' <<<"$CHAINED_OUT"
check 'changed head: the next-step witness was NOT invoked' witness_absent

if ((failures > 0)); then
  echo "closing-scope gate contract test: $failures failure(s)" >&2
  exit 1
fi
echo "ok: the published closing-scope guard blocks a chained next step on a wrong scope or changed head and admits it only on the declared scope"
