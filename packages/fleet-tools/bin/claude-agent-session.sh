#!/usr/bin/env bash
# Restore an archived QueueExecutor Claude transcript into the current
# checkout and print the local `claude --resume` command. The runner itself
# is ephemeral; archive resume is the only supported session recovery path.
set -euo pipefail

TRANSCRIPTS_BUCKET="${CLAUDE_AGENT_TRANSCRIPTS_BUCKET:-agent-lcars-session-transcripts}"

usage() {
  cat <<EOF
Usage: $(basename "$0") resume-archive <uri|run-id>

Downloads one archived transcript into the current checkout's local
~/.claude/projects/ directory and prints the matching `claude --resume`
command.

Arguments:
  gs://.../<session-id>.jsonl  An exact transcript URI.
  <run-id>                    A QueueExecutor run ID, such as
                              work:<ulid>/r1 or octo/example#42/r1. The
                              archive must contain one transcript; otherwise
                              pass the exact URI.
EOF
  exit 1
}

resolve_archive_uri() {
  local arg="$1" prefix
  if [[ "$arg" == gs://*.jsonl ]]; then
    echo "$arg"
    return 0
  fi
  if [[ ! "$arg" =~ ^[A-Za-z0-9._:/#-]+$ ]] || [[ "$arg" == *..* ]]; then
    echo "Argument must be a gs://.../<session-id>.jsonl URI or a QueueExecutor run ID, got: $arg" >&2
    exit 1
  fi
  prefix="gs://$TRANSCRIPTS_BUCKET/runs/$arg/"
  local matches=()
  # `**` crosses the adapter directory beneath each run (for example,
  # `.../claude-code/<session-id>.jsonl`).
  mapfile -t matches < <(gcloud storage ls "${prefix}**/*.jsonl" 2>/dev/null || true)
  if [ ${#matches[@]} -eq 0 ]; then
    echo "No transcripts found under $prefix" >&2
    exit 1
  elif [ ${#matches[@]} -gt 1 ]; then
    echo "Multiple transcripts found for run $arg; pass the full URI:" >&2
    printf '  %s\n' "${matches[@]}" >&2
    exit 1
  fi
  echo "${matches[0]}"
}

[ "${1:-}" = 'resume-archive' ] || usage
[ $# -eq 2 ] || usage
gcs_uri="$(resolve_archive_uri "$2")"

base="$(basename "$gcs_uri")"
session_id="${base%.jsonl}"
if [ "$base" = "$session_id" ]; then
  echo "Not a .jsonl transcript URI: $gcs_uri" >&2
  exit 1
fi

# The same cwd -> project-dir slug Claude Code itself computes: '/' and '.'
# both become '-'.
slug="$(printf '%s' "$PWD" | sed 's/[\/.]/-/g')"
dest_dir="$HOME/.claude/projects/$slug"
dest_file="$dest_dir/$session_id.jsonl"

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT
echo "Downloading $gcs_uri ..." >&2
gcloud storage cp "$gcs_uri" "$tmp_file"

mkdir -p "$dest_dir"
if [ -e "$dest_file" ]; then
  if cmp -s "$tmp_file" "$dest_file"; then
    echo "Already present and identical: $dest_file (no-op)" >&2
  else
    echo "Refusing to overwrite $dest_file: existing content differs from $gcs_uri." >&2
    exit 1
  fi
else
  mv "$tmp_file" "$dest_file"
  echo "Saved transcript to $dest_file" >&2
fi

echo
echo "cd $PWD && claude --resume $session_id"
echo "# Caveat: cwd/file paths inside this transcript refer to the runner's checkout, not this one." >&2
