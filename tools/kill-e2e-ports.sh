#!/bin/bash
# Frees the ports the console e2e suite's `e2e` target binds before each run:
# 4200 (the standalone Next.js server Playwright's webServer starts, see
# apps/console-e2e/playwright.config.ts) and the Firebase emulator suite's
# default ports -- this repo's firebase.json has no "emulators" port
# override, so `firebase emulators:exec` always uses the CLI's own defaults
# (ui 4000, hub 4400, auth 9099, firestore 8080, eventarc 9299 -- see
# node_modules/firebase-tools/lib/emulator/constants.js). A prior run that
# crashed or was killed mid-suite can leave one of these bound, which turns
# into an opaque EADDRINUSE on the next run instead of a clean retry.
#
# Ported from members' tools/kill-e2e-ports.sh (this repo's origin), trimmed
# to agent-lcars' single e2e project and its own emulator port set.

set -uo pipefail

PORTS=(4200 4000 4400 9099 8080 9299)

for port in "${PORTS[@]}"; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "kill-e2e-ports: freeing port $port (pid(s): $pids)"
    kill -9 $pids 2>/dev/null || true
  fi
done

# The Firestore emulator's underlying process is a separately-forked Java
# process (not a child that dies with its parent on a hard kill), so it can
# survive the port-based kill above.
pkill -f "cloud-firestore-emulator" 2>/dev/null || true

# Stale hub locator file from a crashed run confuses the next `emulators:exec`
# invocation into thinking a hub is already running. Matches this project's
# own `--project=demo-no-project` (see apps/console-e2e/project.json's e2e
# target).
rm -f /tmp/hub-demo-no-project.json 2>/dev/null || true

exit 0
