#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

consumer="$test_root/consumer"
mkdir -p "$consumer"
bash "$script_dir/assert-consumer-boundaries.sh" "$consumer" example/consumer

mkdir -p "$consumer/.agents/skills/agent-protocol"
if bash "$script_dir/assert-consumer-boundaries.sh" "$consumer" example/consumer; then
  echo "copied agent-protocol unexpectedly passed" >&2
  exit 1
fi
rm -r "$consumer/.agents"

mkdir -p "$consumer/.agents/skills/github-ci-monitor"
touch "$consumer/.agents/skills/github-ci-monitor/SKILL.md"
if bash "$script_dir/assert-consumer-boundaries.sh" "$consumer" example/consumer; then
  echo "copied github-ci-monitor unexpectedly passed" >&2
  exit 1
fi

lcars="$test_root/agent-lcars"
mkdir -p "$lcars/.agents/skills" "$lcars/agents/shared/skills/agent-protocol"
ln -s ../../agents/shared/skills/agent-protocol "$lcars/.agents/skills/agent-protocol"
bash "$script_dir/assert-consumer-boundaries.sh" "$lcars" jlapenna/agent-lcars

rm "$lcars/.agents/skills/agent-protocol"
mkdir "$lcars/.agents/skills/agent-protocol"
if bash "$script_dir/assert-consumer-boundaries.sh" "$lcars" jlapenna/agent-lcars; then
  echo "copied Agent LCARS protocol unexpectedly passed" >&2
  exit 1
fi
