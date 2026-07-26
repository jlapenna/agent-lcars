#!/bin/bash
# Frees the ports the console e2e suite's `e2e` target binds before each run:
# 4200 (the standalone Next.js server Playwright's webServer starts, see
# apps/console-e2e/playwright.config.ts) and the Firebase emulator suite's
# default ports (auth 9099, firestore 8080, eventarc 9299 -- this repo has no
# firebase.json "emulators" port override, so `firebase emulators:exec`
# always uses these). A prior run that crashed or was killed mid-suite can
# leave one of these bound, which turns into an opaque EADDRINUSE on the next
# run instead of a clean retry.

set -uo pipefail

PORTS=(4200 9099 8080 9299)

for port in "${PORTS[@]}"; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "kill-e2e-ports: freeing port $port (pid(s): $pids)"
    kill -9 $pids 2>/dev/null || true
  fi
done

exit 0
