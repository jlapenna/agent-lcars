#!/usr/bin/env bash

set -euo pipefail

consumer_root="${1:?consumer root is required}"
repository="${2:?repository is required}"
shared_skill="$consumer_root/.agents/skills/agent-protocol"
monitor_skill="$consumer_root/.agents/skills/github-ci-monitor/SKILL.md"

if [ -e "$monitor_skill" ] || [ -L "$monitor_skill" ]; then
  echo "::error::Consumer repositories must use the repo-tools github-ci-monitor skill; remove $monitor_skill" >&2
  exit 1
fi

if [ "$repository" != "jlapenna/agent-lcars" ]; then
  if [ -e "$shared_skill" ] || [ -L "$shared_skill" ]; then
    echo "::error::Consumer repositories must read agent-protocol through AGENT_PROTOCOL_PATH; remove $shared_skill" >&2
    exit 1
  fi
  exit 0
fi

expected="$(realpath "$consumer_root/agents/shared/skills/agent-protocol")"
if [ ! -L "$shared_skill" ] || [ "$(realpath "$shared_skill")" != "$expected" ]; then
  echo "::error::Agent LCARS must expose agent-protocol only through its canonical symlink" >&2
  exit 1
fi
