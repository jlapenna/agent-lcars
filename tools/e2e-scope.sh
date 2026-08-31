#!/usr/bin/env bash
# Decide whether the CI browser suite must run. This script intentionally
# fails open: missing comparison data or a broken affected query runs E2E.
set -euo pipefail

run=false

if [[ "$EVENT_NAME" != pull_request && "$EVENT_NAME" != push ]]; then
  run=true
elif [[ -z "$BASE_SHA" || "$BASE_SHA" =~ ^0+$ ]] || \
  ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  echo "::warning::No usable E2E comparison base; running the suite."
  run=true
else
  if ! affected_json="$(
    ./tools/nx show projects --affected \
      --base="$BASE_SHA" \
      --head="$HEAD_SHA" \
      --projects='@agent-lcars/console-e2e' \
      --json
  )"; then
    echo "::warning::Nx affected detection failed; running the suite."
    run=true
  elif ! affected_count="$(
    node -e \
      "const fs=require('node:fs'); process.stdout.write(String(JSON.parse(fs.readFileSync(0, 'utf8')).length))" \
      <<< "$affected_json"
  )"; then
    echo "::warning::Nx affected output was invalid; running the suite."
    run=true
  elif (( affected_count > 0 )); then
    run=true
  elif ! changed_files="$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")"; then
    echo "::warning::Changed-file detection failed; running the suite."
    run=true
  elif grep -E \
    '^(\.github/workflows/ci\.yml|tools/e2e-local\.sh|tools/e2e-docker\.sh|tools/kill-e2e-ports\.sh|tools/e2e/|tools/e2e-runner/)' \
    <<< "$changed_files" >/dev/null; then
    run=true
  fi
fi

echo "run=$run" >> "$GITHUB_OUTPUT"
if [[ "$run" == false ]]; then
  echo "::notice::Console and its E2E harness are unaffected; skipping browser setup and tests."
fi
