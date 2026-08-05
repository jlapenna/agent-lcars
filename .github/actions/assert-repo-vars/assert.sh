#!/usr/bin/env bash
# Shared fail-fast preamble for workflows that depend on repo variables:
# every empty NAME is reported in one ::error:: line so a fresh consumer
# repo learns its whole missing-variable list from a single failed run,
# not one variable per attempt.
set -euo pipefail

: "${VARS:?VARS is required}"

missing=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    *=*) ;;
    # A line with no `=` is a multi-line value's continuation, never a
    # NAME=VALUE pair of its own - its variable already proved non-empty
    # on its first line.
    *) continue ;;
  esac
  name="${line%%=*}"
  value="${line#*=}"
  [ -z "$value" ] && missing="$missing $name"
done <<<"$VARS"

if [ -n "$missing" ]; then
  echo "::error::Missing required repo variable(s):$missing"
  exit 1
fi
