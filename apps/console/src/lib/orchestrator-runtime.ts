import 'server-only';

import {
  type Clock,
  FirestoreStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { required } from '@agent-lcars/util-server';

import { drainOutbox } from '@/lib/orchestrator-dispatch';
import type { OrchestratorRouteDeps } from '@/lib/orchestrator-routes';

/**
 * Builds the orchestrator's real runtime dependencies -- a Firestore-backed
 * store, the orchestrator itself wired to a real clock, and the outbox
 * drain bound to the fleet's GitHub token. Memoized at module scope so every
 * route handler invoked within one running server instance shares the same
 * store connection rather than opening a new one per request.
 *
 * `PROJECT_ID` and `DISPATCH_FIRESTORE_DATABASE_ID` are already deployed in
 * apphosting.yaml (see hosted-webhook-queue.ts for the same `PROJECT_ID`
 * read pattern). The GitHub token is re-read from the environment on every
 * drain rather than captured once, so a rotated secret takes effect without
 * a restart.
 */

const utcClock: Clock = { now: () => new Date().toISOString() };

let cached: OrchestratorRouteDeps | undefined;

export function createOrchestratorRuntime(): OrchestratorRouteDeps {
  if (cached !== undefined) return cached;

  const store = new FirestoreStore({
    projectId: required('PROJECT_ID'),
    databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
  });
  const orchestrator = new Orchestrator(store, utcClock);

  cached = {
    store,
    orchestrator,
    drain: () =>
      drainOutbox({
        store,
        orchestrator,
        githubToken: required('AGENT_LCARS_GITHUB_TOKEN'),
      }),
  };
  return cached;
}
