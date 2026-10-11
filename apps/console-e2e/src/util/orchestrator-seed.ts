import {
  decidedRun,
  FirestoreStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';

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
  if (
    process.env['E2E_HERMETIC'] !== '1' ||
    process.env['PROJECT_ID'] !== 'demo-no-project' ||
    !process.env['FIRESTORE_EMULATOR_HOST']
  ) {
    throw new Error('Orchestrator fixtures require the hermetic emulator');
  }
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

/** A real durable webhook-projection write, with no fixture route/cache bust. */
export async function updateDashboardAnchor(params: {
  issue: number;
  title?: string;
  remove?: boolean;
  mergeableState?: 'clean' | 'behind';
  requestedReviewerLogins?: string[];
  sourceUpdatedAt?: string;
}) {
  const store = firestoreStore();
  const anchor = { repo: E2E_FIXTURE_REPOSITORY, issue: params.issue };
  const current = await store.readGithubAnchorProjection(anchor);
  if (!current) throw new Error('Missing seeded anchor');
  const generation = await store.beginGithubAnchorProjectionRefresh(anchor);
  await store.applyGithubAnchorProjectionRefresh({
    anchor,
    generation,
    ...(params.remove
      ? {}
      : {
          projection: {
            ...current,
            title: params.title ?? current.title,
            sourceUpdatedAt: params.sourceUpdatedAt ?? current.sourceUpdatedAt,
            ...(params.mergeableState
              ? { mergeableState: params.mergeableState }
              : {}),
            ...(params.requestedReviewerLogins
              ? { requestedReviewerLogins: params.requestedReviewerLogins }
              : {}),
            observedAt: new Date().toISOString(),
          },
        }),
  });
}

/** Changes the same broker lifecycle the worker completion path owns. */
export async function finishDashboardRun() {
  const orchestrator = new Orchestrator(firestoreStore(), {
    now: () => new Date().toISOString(),
  });
  const result = await orchestrator.cancel(
    `${E2E_FIXTURE_REPOSITORY}#9009/r1`,
    'Console live-update contract',
  );
  if ('refused' in result)
    throw new Error(`Cannot settle fixture run: ${result.reason}`);
}

/** Observe actual Work admission rather than a browser success notification. */
export async function readTaskAdmission(issue: number) {
  const store = firestoreStore();
  const taskId = { repo: E2E_FIXTURE_REPOSITORY, issue };
  const task = await store.readTask(taskId);
  const run = await store.readActiveRun(taskId);
  return { task: task?.task, run };
}

/** A finished delivery alongside the existing duplicate live-run anomaly. */
export async function seedTaskDeliverableHistory() {
  const store = firestoreStore();
  const prior = await store.readRun(`${E2E_FIXTURE_REPOSITORY}#9003/r1`);
  if (!prior) throw new Error('Missing finished fixture run');
  const task = { repo: E2E_FIXTURE_REPOSITORY, issue: 9008 };
  const runId = `${E2E_FIXTURE_REPOSITORY}#9008/r0`;
  const current = await store.readTask(task);
  if (!current) throw new Error('Missing task fixture');
  await store.apply({
    expectedRevision: current.revision,
    decision: {
      task: { ...current.task, runCount: 3 },
      run: {
        ...prior,
        task,
        runId,
        result: {
          ok: true,
          summary: 'Delivered the repo filter chips',
          ref: `https://github.com/${E2E_FIXTURE_REPOSITORY}/pull/9420`,
        },
      },
      outbox: [],
    },
  });
}

/** >200 durable tasks, with the only stopped item behind the first raw page. */
export async function seedWorkPagination() {
  const store = firestoreStore();
  for (let index = 1; index <= 205; index++) {
    const workId = String(index).padStart(26, '0');
    const orchestrator = new Orchestrator(store, {
      now: () => new Date(Date.UTC(2000, 0, 1) + index * 1000).toISOString(),
    });
    const result = await orchestrator.request({
      taskId: { workId },
      requestId: workId,
      pipeline: 'codex',
      work: {
        origin: { principal: 'user:pagination-fixture', channel: 'console' },
        spec: {
          title: `Pagination fixture ${index}`,
          description: 'Pagination regression fixture',
          pipeline: 'codex',
          target: { repo: E2E_FIXTURE_REPOSITORY },
        },
      },
    });
    if ('refused' in result) throw new Error(result.reason);
    if (index === 1) {
      const run = decidedRun(result);
      await orchestrator.confirmDispatch(run.runId);
      await orchestrator.report(run.runId, {
        ok: true,
        summary: 'park',
      });
    }
  }
}
