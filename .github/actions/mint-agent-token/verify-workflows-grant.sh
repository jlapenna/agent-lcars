#!/usr/bin/env bash
# Verify that a token minted with this call's own permission-* inputs would
# actually carry exactly the `workflows` permission this caller asked for -
# no more, no less - before any later step (including an agent's own model
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
# its OWN probe token via the identical permissions object the real "Mint
# Agent LCARS installation token" step above just requested, inspects that
# response, and revokes the probe token immediately (best-effort - it is
# scoped no more broadly than the real token already in use, and expires
# within the hour regardless).
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

if [ "$permissions_json" = '{}' ]; then
  request_body='{}'
else
  request_body="$(jq -cn --argjson permissions "$permissions_json" '{permissions: $permissions}')"
fi

http_status="$(curl -sS -o "$response_file" -w '%{http_code}' \
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

# Best-effort revoke - never let a revoke failure mask (or be confused
# with) the permission check itself, and never echo the probe token.
if [ -n "$probe_token" ] && [ "$probe_token" != "null" ]; then
  curl -sS -o /dev/null -X DELETE \
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

if [ -n "$REQUESTED_LEVEL" ]; then
  echo "::notice::Installation ${INSTALLATION_ID} has granted 'workflows: ${granted}' - matches the requested level."
fi
