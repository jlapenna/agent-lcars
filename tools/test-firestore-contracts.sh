#!/usr/bin/env bash
# Required Verify consumes this real-store and authenticated HTTP composition gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${FIRESTORE_EMULATOR_HOST:?Run through the owning test-firestore target}"
export REQUIRE_FIRESTORE_EMULATOR=1

pnpm exec vitest run --config libs/orchestrator/vitest.config.mts \
  store-contract.spec.ts capacity-contract.spec.ts capacity-lineage.spec.ts \
  credential-fallback.spec.ts provider-fallback.spec.ts \
  --maxWorkers=1 --no-passWithNoTests
pnpm exec vitest run --config apps/console/vitest.config.mts \
  runs-router.test.ts capacity-routes.test.ts work-provider-fallback.test.ts \
  --maxWorkers=1 --no-passWithNoTests
