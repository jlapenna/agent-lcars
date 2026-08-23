#!/usr/bin/env bash
# Shared fail-fast preamble for workflows that depend on repo variables:
# every empty NAME is reported in one ::error:: line so a fresh consumer
# repo learns its whole missing-variable list from a single failed run,
# not one variable per attempt.
set -euo pipefail

: "${VARS:?VARS is required}"

declare -A values=()
names=()
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
  names+=("$name")
  values["$name"]="$value"
done <<<"$VARS"

required_names=()
if [ -n "${PROFILE:-}" ]; then
  manifest="${GITHUB_ACTION_PATH:?GITHUB_ACTION_PATH is required for profile checks}/../../../config/github-variables.json"
  if [ ! -r "$manifest" ]; then
    echo "::error::Variable contract manifest is unavailable for profile $PROFILE"
    exit 1
  fi

  if ! jq -e --arg profile "$PROFILE" '.profiles[$profile]' "$manifest" >/dev/null; then
    echo "::error::Unknown variable contract profile: $PROFILE"
    exit 1
  fi

  while IFS= read -r name; do
    [ -n "$name" ] && required_names+=("$name")
  done < <(jq -r --arg profile "$PROFILE" \
    '.profiles[$profile].variables | to_entries[] | select(.value.required == true) | .key' \
    "$manifest")
fi

missing=""
declare -A seen=()
for name in "${names[@]}" "${required_names[@]}"; do
  [ -n "$name" ] || continue
  [ -z "${seen[$name]:-}" ] || continue
  seen["$name"]=1
  [ -n "${values[$name]:-}" ] || missing="$missing $name"
done

if [ -n "$missing" ]; then
  echo "::error::Missing required repo variable(s):$missing"
  exit 1
fi
