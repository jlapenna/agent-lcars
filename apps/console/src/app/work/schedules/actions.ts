'use server';

import { createServerFunctionable } from '@orpc/next';

import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifyScheduleTickOidcToken } from '@/lib/github-actions-oidc';
import {
  createOrchestratorRuntime,
  createScheduleStore,
} from '@/lib/orchestrator-runtime';
import { scheduleRouter } from '@/lib/schedule-router';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import type { WorkContext } from '@/lib/work-mint';
import { sessionsForRuns } from '@/lib/work-sessions';

/**
 * Same shape as `work/actions.ts`'s `context()` -- duplicated rather than
 * shared because that file's `context()` is module-private, and this
 * branch was cut before PR #1535 (now on `main`, not yet rebased here)
 * gave `work/actions.ts` an exported helper other routes could reuse. A
 * later rebase is the place to fold the two together, not this task.
 */
async function context(): Promise<WorkContext> {
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
    maxLiveRuns: workMaxLiveRuns(),
    scheduleStore: createScheduleStore(),
    grants: workGrants,
    now: () => new Date(),
  };
}

const functionable = createServerFunctionable({ context });

const createScheduleFn = functionable(scheduleRouter.create);
const listSchedulesFn = functionable(scheduleRouter.list);
const enableScheduleFn = functionable(scheduleRouter.enable);
const disableScheduleFn = functionable(scheduleRouter.disable);

// One-line forwarders, not a behavioral difference from the four
// procedures above: this repo's `fleet/use-server-actions-only` lint rule
// requires every export of a file-level 'use server' module to be a
// literal async function (see `work/actions.ts`'s identical comment).
export async function createSchedule(
  input: Parameters<typeof createScheduleFn>[0],
) {
  return createScheduleFn(input);
}
export async function listSchedules(
  input: Parameters<typeof listSchedulesFn>[0],
) {
  return listSchedulesFn(input);
}
export async function enableSchedule(
  input: Parameters<typeof enableScheduleFn>[0],
) {
  return enableScheduleFn(input);
}
export async function disableSchedule(
  input: Parameters<typeof disableScheduleFn>[0],
) {
  return disableScheduleFn(input);
}
