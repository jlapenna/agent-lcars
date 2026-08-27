#!/usr/bin/env bash

set -euo pipefail
umask 077

MAX_ATTACHMENT_BYTES=104857600

usage() {
  cat >&2 <<'EOF'
usage: download-github-attachment.sh <user-attachment-url> <output> [owner/repo] [issue-number]

<user-attachment-url> is either form GitHub renders for an uploaded issue/
comment attachment:
  - an IMAGE asset:      https://github.com/user-attachments/assets/<uuid>
  - a non-image FILE:    https://github.com/user-attachments/files/<id>/<name>

Repository and issue (only used by the assets path, to search the
rendered body for a signed CDN URL) default to AGENT_DISPATCH_CONTEXT,
then GITHUB_REPOSITORY plus ISSUE_NUMBER or ISSUE.
EOF
}

attachment_url="${1:-}"
output="${2:-}"
repository="${3:-}"
issue_number="${4:-}"

if [ -z "$attachment_url" ] || [ -z "$output" ]; then
  usage
  exit 64
fi

# Two distinct URL shapes, two distinct fetch strategies. GitHub renders an
# IMAGE upload as /user-attachments/assets/<uuid> and exposes a signed
# private-user-images.githubusercontent.com URL for it directly in the
# rendered body_html (any authenticated reader, including a bot token, can
# resolve and fetch that). A non-image FILE upload (zip, pdf, ...) instead
# renders as /user-attachments/files/<id>/<name>, with no such signed URL
# surfaced anywhere - the only way to fetch it is a direct, authenticated
# request to that URL itself, and (verified 2026-08-27 against
# supersprinklesracing/girosf#70's attachment) that endpoint 404s for a
# GitHub App/bot-class installation token regardless of granted
# permissions - contents:write+issues:write still 404s - while a real
# user's OAuth/PAT token succeeds. This looks like an identity-class
# restriction on the endpoint, not a permission-scope one. Every fleet
# dispatch's credentials are bot-class only, so this script attempts the
# direct authenticated fetch anyway (in case that ever changes, or a
# caller's credential differs) and turns a failure into an accurate
# diagnostic instead of a bare curl error - see the `files` branch below.
assets_re='^https://github\.com/user-attachments/assets/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})([?#].*)?$'
files_re='^https://github\.com/user-attachments/files/([0-9]+)/[^/?#]+([?#].*)?$'

if [[ "$attachment_url" =~ $assets_re ]]; then
  kind=assets
  attachment_id="${BASH_REMATCH[1],,}"
elif [[ "$attachment_url" =~ $files_re ]]; then
  kind=files
else
  echo "error: expected a github.com/user-attachments/assets/<uuid> or github.com/user-attachments/files/<id>/<name> URL" >&2
  exit 64
fi

if [ -e "$output" ]; then
  echo "error: refusing to overwrite existing output: $output" >&2
  exit 73
fi

output_dir="$(dirname -- "$output")"
mkdir -p -- "$output_dir"
partial="$(mktemp "$output_dir/.github-attachment.XXXXXX")"
cleanup() {
  rm -f -- "$partial"
}
trap cleanup EXIT

if [ "$kind" = files ]; then
  # No repository/issue-number resolution needed here - unlike the assets
  # path below, this fetches the URL directly rather than searching a
  # rendered body for a signed one.
  files_token="$(gh auth token 2>/dev/null || true)"
  if [ -z "$files_token" ]; then
    echo "error: no GitHub credential available (gh auth token returned nothing) to attempt the /files/ download" >&2
    exit 70
  fi
  if ! curl --fail --location --silent --show-error \
    --proto '=https' --proto-redir '=https' --max-time 120 \
    --max-filesize "$MAX_ATTACHMENT_BYTES" \
    -H "Authorization: Bearer $files_token" \
    --output "$partial" "$attachment_url"; then
    cat >&2 <<'EOF'
error: could not download this /user-attachments/files/ attachment with
this run's own credential. This endpoint has been observed to reject
GitHub App/bot-class installation tokens with a 404 even when that same
token can read the issue and repository fine via the REST API - an
identity-class restriction on the endpoint itself, not a permission-scope
one (a token with contents:write+issues:write on the repo still 404s
here, while a real user's OAuth/PAT token succeeds). Every fleet
dispatch's credentials are bot-class only, so this is very likely that
same restriction, not a transient failure.
Ask a human to either re-upload the desired file as an IMAGE attachment
(which gets a fetchable signed CDN URL - see this script's other code
path) or paste/link the specific file content directly in a comment.
EOF
    exit 70
  fi
else
  if [ -z "$repository" ] && [ -n "${AGENT_DISPATCH_CONTEXT:-}" ] && [ -f "$AGENT_DISPATCH_CONTEXT" ]; then
    repository="$(jq -r '.repository? | strings | select(length > 0)' "$AGENT_DISPATCH_CONTEXT")"
  fi
  if [ -z "$issue_number" ] && [ -n "${AGENT_DISPATCH_CONTEXT:-}" ] && [ -f "$AGENT_DISPATCH_CONTEXT" ]; then
    issue_number="$(jq -r '.anchor.number? | tostring | select(test("^[1-9][0-9]*$"))' "$AGENT_DISPATCH_CONTEXT")"
  fi

  repository="${repository:-${GITHUB_REPOSITORY:-}}"
  issue_number="${issue_number:-${ISSUE_NUMBER:-${ISSUE:-}}}"

  if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "error: repository must be owner/name (or available in dispatch context)" >&2
    exit 64
  fi
  if ! [[ "$issue_number" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: issue number is required (or must be available in dispatch context)" >&2
    exit 64
  fi

  extract_signed_url() {
    jq -r --arg attachment_id "$attachment_id" '
      [
        .. | objects | .body_html? // empty |
        scan("https://private-user-images\\.githubusercontent\\.com/[^\\\"<>[:space:]]+") |
        gsub("&amp;"; "&") |
        select(ascii_downcase | contains($attachment_id))
      ][0] // empty
    '
  }

  rendered_anchor="$(
    gh api "repos/$repository/issues/$issue_number" \
      -H 'Accept: application/vnd.github.full+json'
  )"
  signed_url="$(extract_signed_url <<<"$rendered_anchor")"

  if [ -z "$signed_url" ]; then
    rendered_comments="$(
      gh api "repos/$repository/issues/$issue_number/comments?per_page=100" \
        -H 'Accept: application/vnd.github.full+json' --paginate --slurp
    )"
    signed_url="$(extract_signed_url <<<"$rendered_comments")"
  fi

  if ! [[ "$signed_url" == https://private-user-images.githubusercontent.com/* ]]; then
    echo "error: attachment $attachment_id was not found in rendered issue or comment bodies" >&2
    exit 69
  fi

  curl --fail --location --silent --show-error \
    --proto '=https' --proto-redir '=https' --max-time 120 \
    --max-filesize "$MAX_ATTACHMENT_BYTES" \
    --output "$partial" "$signed_url"
fi

if [ ! -s "$partial" ]; then
  echo "error: downloaded attachment is empty" >&2
  exit 65
fi
if [ "$(wc -c < "$partial")" -gt "$MAX_ATTACHMENT_BYTES" ]; then
  echo "error: downloaded attachment exceeds the 100 MiB limit" >&2
  exit 65
fi

mv -- "$partial" "$output"
trap - EXIT
printf '%s\n' "$output"
