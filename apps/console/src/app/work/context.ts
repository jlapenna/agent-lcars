import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifyScheduleTickOidcToken } from '@/lib/github-actions-oidc';
import {
  createOrchestratorRuntime,
  createScheduleStore,
} from '@/lib/orchestrator-runtime';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { queuePipelines, workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import type { WorkContext } from '@/lib/work-mint';
import { sessionForResume, sessionsForRuns } from '@/lib/work-sessions';

/**
 * Builds the router's context from the console session rather than a bearer
 * header - a server function always runs on behalf of the signed-in
 * console user, the same way `queue-workspace.tsx`'s server actions do, so
 * `authenticateWorkRequest` is handed a header-less request and only its
 * session fallback path (`work-auth.ts`) ever runs. The Google ID token
 * verifier and the schedule-tick OIDC verifier are still required by
 * `WorkAuthDeps`'s shape but neither is ever invoked on this path.
 *
 * Deliberately not a `'use server'` module: this is a plain helper shared
 * by `work/actions.ts` and `work/schedules/actions.ts`, not itself a
 * Server Action, so it stays out of both files' Server Action surface
 * (`fleet/use-server-actions-only` requires every export of a file-level
 * `'use server'` module to be a literal async function usable as one).
 */
export async function context(): Promise<WorkContext> {
  const principal = await authenticateWorkRequest(
    new Request('https://console.local/'),
    {
      verifyGoogleIdToken: googleIdTokenVerifier('unused'),
      verifyScheduleTickOidcToken: (token) =>
        verifyScheduleTickOidcToken(token, controlPlaneRepository()),
      session: async () =>
        (await auth()) as { user?: { login?: string } } | null,
      grants: workGrants,
    },
  );
  return {
    principal,
    runtime: createOrchestratorRuntime(),
    sessionsFor: sessionsForRuns,
    getSessionDoc: sessionForResume,
    maxLiveRuns: workMaxLiveRuns(),
    scheduleStore: createScheduleStore(),
    grants: workGrants,
    now: () => new Date(),
    queuePipelines: queuePipelines(),
  };
}
