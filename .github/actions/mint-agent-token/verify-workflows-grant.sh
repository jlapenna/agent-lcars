#!/usr/bin/env bash
# Verify that the installation the token above was minted for carries
# exactly the `workflows` permission this caller actually asked for - no
# more, no less - before any later step (including an agent's own model
# turn) trusts the token.
#
# Runs unconditionally, for EVERY mint-agent-token call, not just ones that
# set permission-workflows: this is a published action
# (docs/published-actions.md) that cross-repository consumers reference at
# `@main` with their own permission-* inputs. A consumer that leaves every
# permission-* input blank - mint-agent-token's own long-documented "give me
# everything the installation approves" pattern - would otherwise silently
# start receiving workflows:write the moment their installation approves
# it, with no opt-in and no preflight, even though they never asked for
# `workflows` specifically (Codex review on jlapenna/agent-lcars#903: gating
# this script on `permission-workflows != ''` protected this repo's own
# three lane workflows, which now pass an explicit allowlist, but not an
# external caller that never sets any permission-* input at all). REQUESTED
# is therefore treated as "none" when permission-workflows was left blank,
# not skipped - an unexpected grant is exactly the case this must catch.
#
# actions/create-github-app-token does not expose the mint REST call's
# `permissions` object as a step output (only token/installation-id/
# app-slug), and GitHub's own docs are explicit that requesting a permission
# an installation has not approved does NOT fail the mint call - it silently
# narrows the token instead ("The installation access token cannot be
# granted permissions that the app was not granted"). A caller that requests
# permission-workflows: write and gets a token back therefore cannot tell,
# from the mint step alone, whether it actually got `workflows` or was
# silently narrowed - it would only find out at push time, deep into an
# agent's turn (jlapenna/agent-lcars#868's whole failure mode).
#
# The only authoritative source for "what did this installation actually
# approve" is a direct call to the REST API as the App itself (JWT auth),
# which create-github-app-token performs internally but does not surface.
# This script re-derives that same short-lived App JWT (the standard
# RS256-over-HTTP recipe GitHub's own docs describe) and reads the
# installation's real granted permissions back with GET
# /app/installations/{id} - a read-only call, no second token minted or
# revoked.
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

http_status="$(curl -sS -o "$response_file" -w '%{http_code}' \
  -H "Authorization: Bearer ${jwt}" \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "${GITHUB_API_URL}/app/installations/${INSTALLATION_ID}")"
response="$(cat "$response_file")"
rm -f "$response_file"

if [ "$http_status" != "200" ]; then
  echo "::error::Could not read installation ${INSTALLATION_ID}'s granted permissions while verifying the 'workflows' capability (HTTP ${http_status}). Response: ${response} - see jlapenna/agent-lcars#868." >&2
  exit 1
fi

granted="$(printf '%s' "$response" | jq -r '.permissions.workflows // "none"')"

if [ "$granted" != "$expected_level" ]; then
  if [ -z "$REQUESTED_LEVEL" ]; then
    echo "::error::This mint-agent-token call did not request permission-workflows, but installation ${INSTALLATION_ID} granted 'workflows: ${granted}' anyway - almost certainly because every permission-* input was left blank (the documented 'unscoped mint = every approved installation permission' default). Now that this installation has approved 'workflows', that default silently includes it too. Pass at least one explicit permission-* input, or permission-workflows: write if this call genuinely needs it, rather than relying on the fully-unscoped default. See jlapenna/agent-lcars#868 and jlapenna/agent-lcars#903." >&2
  else
    echo "::error::Installation ${INSTALLATION_ID} has not granted the requested 'workflows: ${REQUESTED_LEVEL}' permission (currently: ${granted}). The Agent LCARS App declares this permission, but each installation must separately approve it: https://github.com/settings/installations (personal-account installations) or the organization's installation-settings page. A workflow-file push with this token would be rejected at push time. See jlapenna/agent-lcars#868." >&2
  fi
  exit 1
fi

if [ -n "$REQUESTED_LEVEL" ]; then
  echo "::notice::Installation ${INSTALLATION_ID} has granted 'workflows: ${granted}' - matches the requested level."
fi
