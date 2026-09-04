import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifySessionPinTickOidcToken } from '@/lib/github-actions-oidc';
import {
  createOrchestratorRuntime,
  createScheduleStore,
} from '@/lib/orchestrator-runtime';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import type { WorkContext } from '@/lib/work-mint';
import {
  sessionDocsForRuns,
  sessionForResume,
  sessionsForRuns,
} from '@/lib/work-sessions';

/**
 * Builds the router's context from the console session rather than a bearer
 * header - a server function always runs on behalf of the signed-in
 * console user, the same way `queue-workspace.tsx`'s server actions do, so
 * `authenticateWorkRequest` is handed a header-less request and only its
 * session fallback path (`work-auth.ts`) ever runs. The Google ID token and
 * session-pin-tick and GitHub Actions OIDC verifiers are still required by
 * `WorkAuthDeps`'s shape but neither is invoked on this path.
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
      verifySessionPinTickOidcToken: (token) =>
        verifySessionPinTickOidcToken(token, controlPlaneRepository()),
      verifyGithubActionsWorkOidcToken: async () => {
        throw new Error('console work context has no GitHub Actions bearer');
      },
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
    sessionDocsForRuns,
    maxLiveRuns: workMaxLiveRuns(),
    scheduleStore: createScheduleStore(),
    grants: workGrants,
    now: () => new Date(),
  };
}
