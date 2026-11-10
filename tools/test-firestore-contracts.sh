#!/usr/bin/env bash
# Required Verify consumes this real-store and authenticated HTTP composition gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${FIRESTORE_EMULATOR_HOST:?Run through the owning test-firestore target}"
export REQUIRE_FIRESTORE_EMULATOR=1

# Concurrency contracts make two transactions read and then write one document.
# The emulator resolves that deadlock only after a lock wait of about 3.6s per
# attempt (production aborts the younger transaction at once), and the SDK
# retries up to 5 attempts with jittered 1s x1.5 backoff. That bounded budget is
# about 30s on a workstation, so the default 15s test timeout turned a slow
# runner into a timeout before the SDK could commit or fail with ABORTED
# (#3291). Give each test enough time for the SDK to report its own outcome.
timeout_ms=60000

pnpm exec vitest run --config libs/orchestrator/vitest.config.mts \
  store-contract.spec.ts \
  credential-fallback.spec.ts provider-fallback.spec.ts \
  --maxWorkers=1 --no-passWithNoTests --testTimeout="$timeout_ms"
pnpm exec vitest run --config apps/console/vitest.config.mts \
  runs-router.test.ts work-provider-fallback.test.ts repository-job-store.test.ts \
  --maxWorkers=1 --no-passWithNoTests --testTimeout="$timeout_ms"
