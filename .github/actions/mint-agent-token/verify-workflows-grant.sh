#!/usr/bin/env bash
# Verify that a token minted with this call's own permission-* and
# owner/repositories inputs would actually carry exactly the `workflows`
# permission and exactly the repository scope this caller asked for - no
# more, no less - before any later step (including an agent's own model
# turn) trusts the token above.
#
# Runs unconditionally, for EVERY mint-agent-token call, not just ones that
# set permission-workflows: this is a published action
# (docs/published-actions.md) that cross-repository consumers reference at
# `@main` with their own permission-* inputs. A consumer that leaves every
# permission-* input blank - mint-agent-token's own long-documented "give me
# everything the installation approves" pattern - would otherwise silently
# start receiving workflows:write the moment their installation approves
# it, with no opt-in and no preflight (Codex review on
# jlapenna/agent-lcars#903: gating this script on
# `permission-workflows != ''` protected this repo's own three lane
# workflows, which now pass an explicit allowlist, but not an external
# caller that never sets any permission-* input at all). REQUESTED is
# therefore treated as "none" when permission-workflows was left blank, not
# skipped - an unexpected grant is exactly the case this must catch.
#
# IMPORTANT: this cannot be answered by GET /app/installations/{id}. That
# endpoint reports the INSTALLATION's overall approved ceiling, not what a
# SPECIFIC token was scoped down to - an earlier version of this script used
# it and produced a false failure for exactly the case it exists to protect
# (a lane workflow's own explicit, workflows-excluding allowlist: the
# ceiling legitimately includes `workflows` once the installation approves
# it, even though every token minted with that lane's explicit permissions
# object correctly excludes it). The only way to see what a specific set of
# permission-* inputs would actually produce is to mint a token with that
# exact same request and read its own response - which is also the only
# place GitHub ever reports it: create-github-app-token performs this same
# mint call internally but does not expose the response's `permissions`
# object as a step output. This script re-derives a short-lived App JWT
# (the standard RS256-over-HTTP recipe GitHub's own docs describe), mints
# its OWN probe token via the identical permissions object AND repository
# selection the real "Mint Agent LCARS installation token" step above just
# requested, inspects that response, and revokes the probe token immediately
# (best-effort - it is scoped no more broadly than the real token already in
# use, and expires within the hour regardless).
#
# The repository-scope half of this check exists for the same reason as the
# permissions half (jlapenna/homelab#622): posting the probe mint with no
# `repositories` field at all - the pre-port behavior - hits the raw GitHub
# REST API's own default, which is installation-WIDE, not "whatever the real
# token was scoped to". A probe minted that way can verify permissions but
# can never distinguish a correctly repository-scoped real token from one
# that silently ended up scoped to every repository the installation can
# see. create-github-app-token instead defaults an all-blank
# owner/repositories pair to the current workflow repository (see the
# owner/repositories inputs' own description in action.yml), so this probe
# reproduces that same default - not the raw API's - and then checks the
# response's actual `repositories` list against exactly what was requested.
set -euo pipefail

: "${CLIENT_ID:?CLIENT_ID is required}"
: "${PRIVATE_KEY:?PRIVATE_KEY is required}"
: "${INSTALLATION_ID:?INSTALLATION_ID is required}"
REQUESTED_LEVEL="${REQUESTED_LEVEL:-}"
expected_level="${REQUESTED_LEVEL:-none}"
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"
response_file="${RUNNER_TEMP:-/tmp}/verify-workflows-grant-response.json"

b64url() {
  openssl base64 -A | tr -d '\n' | tr '+/' '-_' | tr -d '='
}

# Retry a curl invocation up to 4 attempts with a short linear backoff,
# absorbing a transient transport/TLS failure the way
# actions/create-github-app-token's own internal retry absorbed the
# identical "self-signed certificate" error one step earlier in the same
# composite action in jlapenna/agent-lcars#956 - there, that step's retry
# self-healed in under two seconds, but this script's bare curl calls had
# none and killed the whole dispatch on the very next handshake. Only
# retries curl itself failing to complete the request (DNS, connection
# reset, TLS handshake - a non-zero curl exit); an HTTP-level error
# response (curl exits 0, having gotten a real response) is not a
# transport failure and is left to the existing http_status handling
# below, unretried. Preserves curl's own stderr output and exit code on
# the final attempt, so a real, persistent failure looks the same as it
# always has.
#
# Every call site here uses `-w '%{http_code}'`, and curl writes that
# format string's output - `000` on a transport failure that never got a
# response - to stdout BEFORE exiting non-zero (curl(1), -w: "the output
# is written after a completed transfer", which for a failed transfer is
# still the %{http_code} placeholder value). Each retried attempt's
# `curl "$@"` therefore must have its own stdout captured and discarded on
# failure, not left to fall straight through to this function's own
# stdout - a failed attempt's stray `000` would otherwise land ahead of a
# later successful attempt's real status in the caller's captured output
# (`000201` instead of `201`), corrupting the http_status check below even
# though the retry itself worked (Codex review on #961, P1).
#
# The final, unretried attempt below is deliberately NOT captured the same
# way: this whole function only runs inside the caller's own
# `x="$(curl_retry ...)"`, and bash does not apply `set -e` inside a
# *nested* command substitution unless `inherit_errexit` is on (not set by
# this script) - so wrapping that last attempt in its own `out="$(curl
# ...)"` would silence its failure instead of letting it kill the script,
# exactly the "preserves ... exit code on the final attempt" guarantee
# this function exists to keep. Left as a bare `curl "$@"`, its stdout
# passes straight through to this function's own stdout (safe: it is the
# only attempt whose output can still reach the caller, every earlier one
# having already been discarded above) and a failure aborts the enclosing
# substitution with curl's real exit code, unchanged from before P1/P2.
curl_retry() {
  local attempt status out
  for attempt in 1 2 3; do
    if out="$(curl "$@")"; then
      printf '%s' "$out"
      return 0
    else
      # Capture $? in the else branch, directly against the failed
      # `curl` invocation - not on a later line after the `if` has
      # already completed, whose own status is 0 whenever no branch of
      # it ran (Codex review on #961, P2), which would always log
      # "exit 0" here regardless of curl's real failure.
      status=$?
    fi
    echo "::warning::curl attempt ${attempt} failed (exit ${status}); retrying in ${attempt}s." >&2
    sleep "$attempt"
  done
  curl "$@"
}

now_epoch="$(date +%s)"
header_b64="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
payload_b64="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' \
  "$((now_epoch - 60))" "$((now_epoch + 300))" "$CLIENT_ID" | b64url)"
signing_input="${header_b64}.${payload_b64}"
signature_b64="$(printf '%s' "$signing_input" |
  openssl dgst -sha256 -sign <(printf '%s' "$PRIVATE_KEY") | b64url)"
jwt="${signing_input}.${signature_b64}"

# Rebuild the exact same `permissions` request body the real mint step just
# sent: every non-blank permission-* input, snake_cased to match GitHub's
# REST field names (pull-requests -> pull_requests). Omitted entirely - not
# an empty object - when every input is blank, so this probe reproduces the
# real "fully unscoped = every installation permission" mint behavior
# rather than accidentally narrowing to nothing.
permissions_json="$(jq -cn \
  --arg issues "${PERMISSION_ISSUES:-}" \
  --arg contents "${PERMISSION_CONTENTS:-}" \
  --arg pull_requests "${PERMISSION_PULL_REQUESTS:-}" \
  --arg actions "${PERMISSION_ACTIONS:-}" \
  --arg metadata "${PERMISSION_METADATA:-}" \
  --arg workflows "$REQUESTED_LEVEL" \
  '{issues:$issues, contents:$contents, pull_requests:$pull_requests, actions:$actions, metadata:$metadata, workflows:$workflows}
   | with_entries(select(.value != ""))')"

# Mirror the same repository selection the real mint step just requested
# (jlapenna/homelab#622), so the probe below can verify the REAL token's
# repository scope too - not only its permissions. `expected_repositories`
# is the bare-name list this probe requires the response to match exactly;
# left `[]` for the one case that has no fixed list to compare against - an
# explicit `owner` with no `repositories`, which (like
# create-github-app-token's own OWNER-only input combination) legitimately
# means "every repository the installation can see for that owner", not a
# fixed set.
OWNER="${OWNER:-}"
REPOSITORIES="${REPOSITORIES:-}"
expected_repositories='[]'
if [ -z "$OWNER" ] && [ -z "$REPOSITORIES" ]; then
  # Blank owner and repositories: create-github-app-token defaults this to
  # the current workflow repository, not an installation-wide token - the
  # probe must request (and expect back) that same single repository.
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required when owner and repositories are unset}"
  expected_repositories="$(jq -cn --arg repository "${GITHUB_REPOSITORY#*/}" '[$repository]')"
elif [ -n "$REPOSITORIES" ]; then
  # Match create-github-app-token's comma/newline splitting and accept
  # either bare names or owner/name. The real mint step already validated
  # owner agreement for any owner/name entries.
  expected_repositories="$(jq -cn --arg raw "$REPOSITORIES" '
    $raw
    | gsub(","; "\n")
    | split("\n")
    | map(gsub("^\\s+|\\s+$"; ""))
    | map(select(length > 0))
    | map(split("/") | if length == 1 then .[0] elif length == 2 then .[1] else error("invalid repository input") end)
  ')"
fi

request_body="$(jq -cn \
  --argjson permissions "$permissions_json" \
  --argjson repositories "$expected_repositories" \
  '{}
   + (if ($permissions | length) > 0 then {permissions:$permissions} else {} end)
   + (if ($repositories | length) > 0 then {repositories:$repositories} else {} end)')"

http_status="$(curl_retry -sS -o "$response_file" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${jwt}" \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -d "$request_body" \
  "${GITHUB_API_URL}/app/installations/${INSTALLATION_ID}/access_tokens")"
response="$(cat "$response_file")"
rm -f "$response_file"

if [ "$http_status" != "201" ]; then
  echo "::error::Could not mint a probe token to verify installation ${INSTALLATION_ID}'s actual 'workflows' grant (HTTP ${http_status}). Response: ${response} - see jlapenna/agent-lcars#868." >&2
  exit 1
fi

probe_token="$(printf '%s' "$response" | jq -r '.token')"
granted="$(printf '%s' "$response" | jq -r '.permissions.workflows // "none"')"
granted_repositories="$(printf '%s' "$response" | jq -cS '[(.repositories // [])[].name]')"

# Best-effort revoke - never let a revoke failure mask (or be confused
# with) the permission check itself, and never echo the probe token.
if [ -n "$probe_token" ] && [ "$probe_token" != "null" ]; then
  curl_retry -sS -o /dev/null -X DELETE \
    -H "Authorization: Bearer ${probe_token}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "${GITHUB_API_URL}/installation/token" || true
fi

if [ "$granted" != "$expected_level" ]; then
  if [ -z "$REQUESTED_LEVEL" ]; then
    echo "::error::This mint-agent-token call did not request permission-workflows, but a token minted with its own permission-* inputs would still carry 'workflows: ${granted}' - almost certainly because every permission-* input was left blank (the documented 'unscoped mint = every approved installation permission' default). Now that installation ${INSTALLATION_ID} has approved 'workflows', that default silently includes it too. Pass at least one explicit permission-* input, or permission-workflows: write if this call genuinely needs it, rather than relying on the fully-unscoped default. See jlapenna/agent-lcars#868 and jlapenna/agent-lcars#903." >&2
  else
    echo "::error::Installation ${INSTALLATION_ID} has not granted the requested 'workflows: ${REQUESTED_LEVEL}' permission (currently: ${granted}). The Agent LCARS App declares this permission, but each installation must separately approve it: https://github.com/settings/installations (personal-account installations) or the organization's installation-settings page. A workflow-file push with this token would be rejected at push time. See jlapenna/agent-lcars#868." >&2
  fi
  exit 1
fi

# Repository-scope check (jlapenna/homelab#622): only meaningful when this
# call has a fixed expected list - the owner-only ("every repository for
# this owner") combination above deliberately leaves expected_repositories
# empty and has nothing fixed to compare against. Compares sorted name
# lists so ordering never causes a spurious mismatch. Never echoes the
# probe token - only repository names, which are not secret.
if [ "$expected_repositories" != '[]' ]; then
  expected_sorted="$(printf '%s' "$expected_repositories" | jq -cS 'sort')"
  granted_sorted="$(printf '%s' "$granted_repositories" | jq -cS 'sort')"
  if [ "$granted_sorted" != "$expected_sorted" ]; then
    echo "::error::A token minted with installation ${INSTALLATION_ID}'s own owner/repositories inputs would be scoped to repositories ${granted_sorted}, not the expected ${expected_sorted} - it would carry broader (or narrower) repository access than this call requested. See jlapenna/homelab#622." >&2
    exit 1
  fi
fi

if [ -n "$REQUESTED_LEVEL" ]; then
  echo "::notice::Installation ${INSTALLATION_ID} has granted 'workflows: ${granted}' - matches the requested level."
fi
