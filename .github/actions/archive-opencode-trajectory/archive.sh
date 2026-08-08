#!/usr/bin/env bash

set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${STARTED_AT:?STARTED_AT is required}"

archive_dir="$RUNNER_TEMP/opencode-trajectory"
exports_dir="$archive_dir/sessions"
mkdir -p "$exports_dir"

started_epoch_ms="$(( $(date -u -d "$STARTED_AT" +%s) * 1000 ))"
sessions_path="$archive_dir/session-list.json"
selected_path="$archive_dir/selected-sessions.json"

capture_status=ok
if ! command -v opencode >/dev/null 2>&1; then
  echo "::warning::OpenCode CLI is unavailable after the agent step; no trajectory session can be exported."
  printf '%s\n' '[]' > "$selected_path"
  capture_status=cli-unavailable
elif ! opencode session list --format json -n 100 > "$sessions_path"; then
  echo "::warning::OpenCode session listing failed; no trajectory session can be exported."
  printf '%s\n' '[]' > "$selected_path"
  capture_status=session-list-failed
else
  jq \
    --arg workspace "$GITHUB_WORKSPACE" \
    --argjson started "$started_epoch_ms" \
    '[.[] |
      select((.directory // "") == $workspace) |
      select(((.time.updated // .time.created // .time_updated // 0) | tonumber) >= $started)
    ]' "$sessions_path" > "$selected_path"
fi

exported=0
failed=0
while IFS= read -r session_id; do
  if ! [[ "$session_id" =~ ^[A-Za-z0-9._:-]{1,200}$ ]]; then
    echo "::warning::Skipping malformed OpenCode session ID from session list."
    failed=$((failed + 1))
    continue
  fi
  if opencode export "$session_id" --sanitize > "$exports_dir/$session_id.json"; then
    exported=$((exported + 1))
  else
    echo "::warning::Failed to export sanitized OpenCode session $session_id."
    failed=$((failed + 1))
    rm -f "$exports_dir/$session_id.json"
  fi
done < <(jq -r '.[].id // empty' "$selected_path")

manifest_path="$archive_dir/manifest.json"
jq -n \
  --arg schema agent-lcars.opencode-trajectory/v1 \
  --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg started_at "$STARTED_AT" \
  --arg run_id "${GITHUB_RUN_ID:-}" \
  --arg issue "${ISSUE:-}" \
  --arg status "$capture_status" \
  --argjson selected "$(jq 'length' "$selected_path")" \
  --argjson exported "$exported" \
  --argjson failed "$failed" \
  --slurpfile sessions "$selected_path" \
  '{
    schema: $schema,
    captured_at: $captured_at,
    started_at: $started_at,
    run_id: $run_id,
    issue: $issue,
    capture_status: $status,
    selected_sessions: $selected,
    exported_sessions: $exported,
    failed_exports: $failed,
    sessions: ($sessions[0] | map({
      id,
      title: (.title // null),
      directory: (.directory // null),
      time: (.time // null)
    }))
  }' > "$manifest_path"

if [ "$exported" -eq 0 ] && [ "$capture_status" = ok ]; then
  echo "::warning::No OpenCode session updated in this workspace after $STARTED_AT; the trajectory artifact records that absence."
fi

{
  echo "path=$archive_dir"
  if [ "$exported" -gt 0 ]; then
    echo 'has-sessions=true'
  else
    echo 'has-sessions=false'
  fi
} >> "$GITHUB_OUTPUT"
