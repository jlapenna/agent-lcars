import 'server-only';

import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifyScheduleTickOidcToken } from '@/lib/github-actions-oidc';
import {
  createDispatchTokenProvider,
  DIRECT_RUNNER_PERMISSIONS,
} from '@/lib/github-app-tokens';
import {
  createOrchestratorRuntime,
  createScheduleStore,
} from '@/lib/orchestrator-runtime';
import { createRunsHandler } from '@/lib/runs-router';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
  rawBearerToken,
} from '@/lib/work-auth';
import { queuePipelines, workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import { createWorkHandler } from '@/lib/work-router';
import { sessionsForRuns } from '@/lib/work-sessions';

/** The `servers` URL in the generated OpenAPI document, and the prefix
 *  proxy.ts allow-lists (as `/api/work/v1/` -- see the comment there for
 *  why that list needs the trailing slash and oRPC's matcher does not:
 *  `matchesHttpPathPrefix` is segment-aware, a bare `startsWith` is not). */
const PREFIX = '/api/work/v1';

const handler = createWorkHandler();
const runsHandler = createRunsHandler();
const verifyGoogleIdToken = googleIdTokenVerifier(
  process.env['AGENT_LCARS_WORK_AUDIENCE'] ?? 'agent-lcars-work',
);

/**
 * Single entry point for the whole items + runs API: oRPC's OpenAPI
 * handler does the routing from each contract, so this catch-all only has
 * to resolve the caller and hand over the request.
 *
 * Authentication happens here (it needs the Request and the Auth.js
 * session); authorization is each router's own middleware (`workRouter`'s
 * `operator`, `runsRouter`'s `executor` and per-route token check), which
 * is why the proxy allow-lists this prefix -- the proxy's cookie check
 * would otherwise 401 every bearer-token caller before oRPC saw it.
 *
 * `items` and `runs` are two different oRPC routers with different
 * `$context` shapes, so they are tried in sequence against the same
 * `Request` object rather than merged into one router. This is safe: oRPC's
 * `OpenAPIHandler` (`@orpc/server`'s `FetchHandler`) wraps the incoming
 * `Request` via `@standardserver/fetch`'s `toStandardLazyRequest` --
 * `headers` is a lazy getter and `resolveBody` is a function, not an
 * eagerly-read value. A `.handle()` call that returns `{ matched: false }`
 * never calls `resolveBody`, so `runsHandler.handle(request, ...)` failing
 * to match leaves the body stream untouched for `handler.handle(request,
 * ...)` to read next. No `request.clone()` needed.
 */
async function handle(request: Request): Promise<Response> {
  const bearerToken = rawBearerToken(request);
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

  const runtime = createOrchestratorRuntime();
  const runsResult = await runsHandler.handle(request, {
    prefix: PREFIX,
    context: {
      ...(bearerToken === undefined ? {} : { bearerToken }),
      ...(principal === undefined ? {} : { principal }),
      store: runtime.store,
      orchestrator: runtime.orchestrator,
      tokens: createDispatchTokenProvider(process.env),
      checkoutTokens: createDispatchTokenProvider(
        process.env,
        DIRECT_RUNNER_PERMISSIONS,
      ),
    },
  });
  if (runsResult.matched && runsResult.response !== undefined) {
    return runsResult.response;
  }

  const { matched, response } = await handler.handle(request, {
    prefix: PREFIX,
    context: {
      ...(principal === undefined ? {} : { principal }),
      runtime,
      sessionsFor: sessionsForRuns,
      maxLiveRuns: workMaxLiveRuns(),
      scheduleStore: createScheduleStore(),
      grants: workGrants,
      now: () => new Date(),
      queuePipelines: queuePipelines(),
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
