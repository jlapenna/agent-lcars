#!/bin/bash
# Frees the ports the console e2e suite's `e2e` target binds before each run:
# 4200 (the standalone Next.js server Playwright's webServer starts, see
# apps/console-e2e/playwright.config.ts) and the Firebase emulator suite's
# configured ports in firebase.json (ui 4000, firestore 4002, auth 4003,
# eventarc 4004), plus the CLI defaults for hub 4400 and logging 4500.
# A prior run that
# crashed or was killed mid-suite can leave one of these bound, which turns
# into an opaque EADDRINUSE on the next run instead of a clean retry.
#
# Ported from members' tools/kill-e2e-ports.sh (this repo's origin), trimmed
# to agent-lcars' single e2e project and its own emulator port set.
#
# #908 (containerized E2E) considered deleting this: tools/e2e-docker.sh's
# container path never binds a host port at all, so it has never needed this
# script. But ci.yml's `e2e` job still runs tools/e2e-local.sh directly on
# the host -- fixed ports and all -- because moving it into a container
# needs a dedicated runner pool that doesn't exist yet (#920). This script
# is still load-bearing for that real path, not dead cleanup tooling; revisit
# once #920 lands and ci.yml no longer calls tools/e2e-local.sh.

set -uo pipefail

PORTS=(4200 4000 4002 4003 4004 4400 4500)

for port in "${PORTS[@]}"; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  # Some container/runner kernels expose socket owners through /proc to
  # fuser/ss while lsof returns an empty result even for a listening process.
  # Falling back only when lsof found nothing keeps the usual path portable,
  # while still cleaning up orphaned Playwright webServer children on those
  # hosts instead of letting the next run fail with a misleading EADDRINUSE.
  if [ -z "$pids" ] && command -v fuser >/dev/null 2>&1; then
    pids=$(fuser -n tcp "$port" 2>/dev/null || true)
  fi
  if [ -n "$pids" ]; then
    read -r -a port_pids <<<"${pids//$'\n'/ }"
    echo "kill-e2e-ports: freeing port $port (pid(s): ${port_pids[*]})"
    kill -9 "${port_pids[@]}" 2>/dev/null || true
  fi
done

# An orphaned Java emulator still owns its listening socket and is covered
# by the port scan above. Never kill by executable name: another worktree's
# emulator or preview can use a different port on this same host (#2305).

# Stale hub locator file from a crashed run confuses the next `emulators:exec`
# invocation into thinking a hub is already running. Matches this project's
# own `--project=demo-no-project` (see apps/console-e2e/project.json's e2e
# target).
rm -f /tmp/hub-demo-no-project.json 2>/dev/null || true

exit 0
