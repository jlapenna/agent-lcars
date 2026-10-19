#!/usr/bin/env bash
# Reject implicit installation-wide permissions before the native mint runs.
set -euo pipefail
for permission in "${PERMISSION_ISSUES:-}" "${PERMISSION_CONTENTS:-}" \
  "${PERMISSION_PULL_REQUESTS:-}" "${PERMISSION_ACTIONS:-}" \
  "${PERMISSION_METADATA:-}" "${PERMISSION_WORKFLOWS:-}"; do
  # Require a supported level, not merely a non-ASCII byte that the native
  # action may trim as Unicode whitespace before parsing its inputs.
  if [[ "$permission" =~ ^[[:space:]]*(read|write)[[:space:]]*$ ]]; then
    exit 0
  fi
done
echo "::error::Set at least one explicit permission-* input with read or write; inheriting all installation permissions is unsupported." >&2
exit 1
