import 'server-only';

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
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import { createWorkHandler } from '@/lib/work-router';
import { sessionsForRuns } from '@/lib/work-sessions';

/** The `servers` URL in the generated OpenAPI document, and the prefix
 *  proxy.ts allow-lists (as `/api/work/v1/` -- see the comment there for
 *  why that list needs the trailing slash and oRPC's matcher does not:
 *  `matchesHttpPathPrefix` is segment-aware, a bare `startsWith` is not). */
const PREFIX = '/api/work/v1';

const handler = createWorkHandler();
const verifyGoogleIdToken = googleIdTokenVerifier(
  process.env['AGENT_LCARS_WORK_AUDIENCE'] ?? 'agent-lcars-work',
);

/**
 * Single entry point for the whole items API: oRPC's OpenAPI handler does
 * the routing from the contract, so this catch-all only has to resolve the
 * caller and hand over the request.
 *
 * Authentication happens here (it needs the Request and the Auth.js
 * session); authorization is the router's own `operator` middleware, which
 * is why the proxy allow-lists this prefix -- the proxy's cookie check
 * would otherwise 401 every bearer-token caller before oRPC saw it.
 */
async function handle(request: Request): Promise<Response> {
  const principal = await authenticateWorkRequest(request, {
    verifyGoogleIdToken,
    // #1502 sub-project 3: the scheduled tick trigger, like the reconciler,
    // is pinned to the control-plane home -- not the request path's
    // allow-list. See github-actions-oidc.ts's schedule-tick section.
    verifyScheduleTickOidcToken: (token) =>
      verifyScheduleTickOidcToken(token, controlPlaneRepository()),
    session: async () => (await auth()) as { user?: { login?: string } } | null,
    grants: workGrants,
  });
  const { matched, response } = await handler.handle(request, {
    prefix: PREFIX,
    context: {
      ...(principal === undefined ? {} : { principal }),
      runtime: createOrchestratorRuntime(),
      sessionsFor: sessionsForRuns,
      maxLiveRuns: workMaxLiveRuns(),
      scheduleStore: createScheduleStore(),
      grants: workGrants,
      now: () => new Date(),
    },
  });
  return matched && response !== undefined
    ? response
    : Response.json({ error: 'Not found' }, { status: 404 });
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
export const PATCH = handle;
