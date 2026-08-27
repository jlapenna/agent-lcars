'use server';

import { createServerFunctionable } from '@orpc/next';

import { auth } from '@/auth';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import { type WorkContext, workRouter } from '@/lib/work-router';
import { sessionsForRuns } from '@/lib/work-sessions';

/**
 * Builds the router's context from the console session rather than a bearer
 * header - a server function always runs on behalf of the signed-in
 * console user, the same way `queue-workspace.tsx`'s server actions do, so
 * `authenticateWorkRequest` is handed a header-less request and only its
 * session fallback path (`work-auth.ts`) ever runs. The Google ID token
 * verifier is still required by `WorkAuthDeps`'s shape but is never
 * invoked on this path.
 */
async function context(): Promise<WorkContext> {
  const principal = await authenticateWorkRequest(
    new Request('https://console.local/'),
    {
      verifyGoogleIdToken: googleIdTokenVerifier('unused'),
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
  };
}

const functionable = createServerFunctionable({ context });

const createItemFn = functionable(workRouter.create);
const cancelItemFn = functionable(workRouter.cancel);
const redispatchItemFn = functionable(workRouter.redispatch);
const getItemFn = functionable(workRouter.get);
const listItemsFn = functionable(workRouter.list);

/**
 * One-line forwarders, not a behavioral difference from the five
 * procedures above: this repo's `fleet/use-server-actions-only` lint rule
 * requires every export of a file-level 'use server' module to be a
 * literal async function (so Next's Server Actions transform can find and
 * register it) - `functionable(workRouter.x)`'s return value is a call
 * expression's result, which the rule refuses to export directly.
 */
export async function createItem(input: Parameters<typeof createItemFn>[0]) {
  return createItemFn(input);
}
export async function cancelItem(input: Parameters<typeof cancelItemFn>[0]) {
  return cancelItemFn(input);
}
export async function redispatchItem(
  input: Parameters<typeof redispatchItemFn>[0],
) {
  return redispatchItemFn(input);
}
export async function getItem(input: Parameters<typeof getItemFn>[0]) {
  return getItemFn(input);
}
export async function listItems(input: Parameters<typeof listItemsFn>[0]) {
  return listItemsFn(input);
}
