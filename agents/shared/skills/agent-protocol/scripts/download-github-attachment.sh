#!/usr/bin/env bash

set -euo pipefail
umask 077

MAX_ATTACHMENT_BYTES=104857600

usage() {
  cat >&2 <<'EOF'
usage: download-github-attachment.sh <user-attachment-url> <output> [owner/repo] [issue-number]

Repository and issue default to AGENT_DISPATCH_CONTEXT, then
GITHUB_REPOSITORY plus ISSUE_NUMBER or ISSUE.
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

if [[ "$attachment_url" =~ ^https://github\.com/user-attachments/assets/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})([?#].*)?$ ]]; then
  attachment_id="${BASH_REMATCH[1],,}"
else
  echo "error: expected a github.com/user-attachments/assets/<uuid> URL" >&2
  exit 64
fi

if [ -z "$repository" ] && [ -n "${AGENT_DISPATCH_CONTEXT:-}" ] && [ -f "$AGENT_DISPATCH_CONTEXT" ]; then
  repository="$(jq -er '.repository | select(type == "string" and length > 0)' "$AGENT_DISPATCH_CONTEXT")"
fi
if [ -z "$issue_number" ] && [ -n "${AGENT_DISPATCH_CONTEXT:-}" ] && [ -f "$AGENT_DISPATCH_CONTEXT" ]; then
  issue_number="$(jq -er '.anchor.number | tostring | select(test("^[1-9][0-9]*$"))' "$AGENT_DISPATCH_CONTEXT")"
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
if [ -e "$output" ]; then
  echo "error: refusing to overwrite existing output: $output" >&2
  exit 73
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

output_dir="$(dirname -- "$output")"
mkdir -p -- "$output_dir"
partial="$(mktemp "$output_dir/.github-attachment.XXXXXX")"
cleanup() {
  rm -f -- "$partial"
}
trap cleanup EXIT

curl --fail --location --silent --show-error \
  --proto '=https' --proto-redir '=https' --max-time 120 \
  --max-filesize "$MAX_ATTACHMENT_BYTES" \
  --output "$partial" "$signed_url"

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
