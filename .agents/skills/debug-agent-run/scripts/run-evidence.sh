#!/usr/bin/env bash
# Read-only evidence from current QueueExecutor containers and linked worktrees.
set -euo pipefail
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/run-evidence.py" "$@"
