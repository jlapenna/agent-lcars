#!/usr/bin/env bash
set -euo pipefail
action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for name in PERMISSION_ISSUES PERMISSION_CONTENTS PERMISSION_PULL_REQUESTS \
  PERMISSION_ACTIONS PERMISSION_METADATA PERMISSION_WORKFLOWS; do
  unset "$name"
done

if bash "$action_dir/require-explicit-permissions.sh" 2>/dev/null; then
  echo 'empty permission inputs must refuse the mint' >&2
  exit 1
fi
if PERMISSION_CONTENTS=$' \t\n' bash "$action_dir/require-explicit-permissions.sh" 2>/dev/null; then
  echo 'whitespace-only permission inputs must refuse the mint' >&2
  exit 1
fi
if PERMISSION_CONTENTS=$'\u00a0\u2003' bash "$action_dir/require-explicit-permissions.sh" 2>/dev/null; then
  echo 'Unicode whitespace-only inputs must refuse the mint' >&2
  exit 1
fi
for name in PERMISSION_ISSUES PERMISSION_CONTENTS PERMISSION_PULL_REQUESTS \
  PERMISSION_ACTIONS PERMISSION_METADATA PERMISSION_WORKFLOWS; do
  env "$name=write" bash "$action_dir/require-explicit-permissions.sh"
done
PERMISSION_METADATA=read bash "$action_dir/require-explicit-permissions.sh"
echo 'explicit permission admission: all cases passed'
