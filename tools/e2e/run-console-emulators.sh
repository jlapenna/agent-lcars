#!/usr/bin/env bash
# Run the console suite under Firebase and turn harness failures into a
# dependency-named Actions annotation. Playwright already annotates assertion
# failures; firebase-tools otherwise exits non-zero with only a late generic
# Nx failure, which made a dead emulator look like a broken product test.

set -uo pipefail

LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/agent-lcars-e2e-emulators.XXXXXX.log")"
cleanup() {
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

set +e
pnpm exec firebase emulators:exec \
  --only auth,firestore,eventarc \
  --project=demo-no-project \
  "./tools/nx run @agent-lcars/console-e2e:e2e-run" 2>&1 | tee "$LOG_FILE"
status=${PIPESTATUS[0]}
set -e

if [ "$status" -eq 0 ]; then
  exit 0
fi

if grep -Eq 'Firestore Emulator has exited|firestore:.*Fatal error occurred' "$LOG_FILE"; then
  echo "::error title=Console E2E environment::Firestore emulator exited before the Playwright suite completed (firebase emulators:exec exit $status)."
elif grep -Eq 'Authentication Emulator has exited|auth:.*Fatal error occurred' "$LOG_FILE"; then
  echo "::error title=Console E2E environment::Authentication emulator exited before the Playwright suite completed (firebase emulators:exec exit $status)."
elif grep -Eq 'Eventarc Emulator has exited|eventarc:.*Fatal error occurred' "$LOG_FILE"; then
  echo "::error title=Console E2E environment::Eventarc emulator exited before the Playwright suite completed (firebase emulators:exec exit $status)."
elif grep -Eqi 'EADDRINUSE|port [0-9]+ is not open|address already in use|could not start.*emulator' "$LOG_FILE"; then
  echo "::error title=Console E2E environment::Firebase emulator startup failed because a required local port was unavailable (firebase emulators:exec exit $status)."
elif ! grep -q 'Playwright Run Summary' "$LOG_FILE"; then
  echo "::error title=Console E2E environment::Firebase emulator harness failed before Playwright produced a run summary (firebase emulators:exec exit $status)."
fi

exit "$status"
