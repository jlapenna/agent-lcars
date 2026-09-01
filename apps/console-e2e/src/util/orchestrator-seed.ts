import { FirestoreStore } from '@agent-lcars/orchestrator';

/**
 * Seeds `@agent-lcars/orchestrator` task/run documents directly against the
 * same Firestore emulator the running console server reads - not through an
 * `/api/e2e/*` route (agent-lcars#1183 phase 2 review: growing that
 * production surface just to serve a test fixture was rejected).
 *
 * This is safe unlike `seed.ts`'s own doc comment on CLI session fixtures,
 * which explicitly warns that direct-from-test-process Firestore writes
 * "don't reach the store the running app server reads" - that warning is
 * about `getAgentTelemetryWriterFirestore()`'s own project/auth resolution
 * (`libs/telemetry/src/server/firestore-client.ts`), not a property of the
 * emulator itself. `FirestoreStore` here uses the same plain
 * `{projectId, databaseId}` construction the production seed routes and
 * `orchestrator-runtime.ts` already use successfully - `@google-cloud/
 * firestore` itself auto-detects `FIRESTORE_EMULATOR_HOST` from the
 * process environment, no explicit host/auth wiring needed. Both this test
 * process and the app server's own subprocess inherit `PROJECT_ID`/
 * `DISPATCH_FIRESTORE_DATABASE_ID`/`FIRESTORE_EMULATOR_HOST` from the same
 * `firebase emulators:exec` session (see tools/e2e-local.sh's env chain and
 * tools/e2e/ci.env), so a write from either process lands in the one
 * emulator instance the other reads.
 *
 * There is also no caching layer to fight: `task-detail.ts`'s
 * `readAuthoritativeTaskStates` call is never wrapped in `'use cache'` (only
 * the GitHub-sourced half of that page is, and only outside e2e - see
 * `getCachedTaskSource`'s `isE2eTesting()` bypass), so a write here is
 * visible on the very next request the app server serves.
 */

/** The one repo explicitly configured in `tools/e2e/ci.env` - mirrors
 * `E2E_FIXTURE_REPO` in the frontend app's `lib/e2e-github-fixtures.ts`
 * (duplicated for the same module-boundary reason `seed.ts`'s other
 * mirrored constants are: this `platform:web` e2e project cannot import
 * from the `platform:nextjs` frontend app - `@agent-lcars/orchestrator`
 * itself is a `scope:shared` lib, not app code, so importing it directly
 * here is a different, sanctioned kind of dependency). */
export const E2E_FIXTURE_REPOSITORY = 'supersprinklesracing/sprinkles';

function firestoreStore(): FirestoreStore {
  return new FirestoreStore({
    projectId: process.env['PROJECT_ID'] ?? 'demo-no-project',
    databaseId: process.env['DISPATCH_FIRESTORE_DATABASE_ID'] ?? '(default)',
  });
}

/** Reads the broker's authoritative active run from the shared emulator.
 * This lets browser tests prove an outbox delivery was confirmed rather than
 * accepting a success toast while `drainOutbox` retained a failed write. */
export async function readActiveOrchestratorRun(params: {
  issue: number;
  repository?: string;
}): Promise<{ pipeline: string; state: string } | undefined> {
  const run = await firestoreStore().readActiveRun({
    repo: params.repository ?? E2E_FIXTURE_REPOSITORY,
    issue: params.issue,
  });
  return run === undefined
    ? undefined
    : { pipeline: run.pipeline, state: run.state };
}
