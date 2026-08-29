import 'server-only';

import { auth } from '@/auth';
import { codexAuthStore } from '@/lib/codex-auth-store';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifySessionPinTickOidcToken } from '@/lib/github-actions-oidc';
import {
  createDispatchTokenProvider,
  DIRECT_RUNNER_PERMISSIONS,
  lazyDispatchTokenProvider,
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
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import { createWorkHandler } from '@/lib/work-router';
import { sessionForResume, sessionsForRuns } from '@/lib/work-sessions';

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
    verifySessionPinTickOidcToken: (token) =>
      verifySessionPinTickOidcToken(token, controlPlaneRepository()),
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
      // Same clock the orchestrator's own `utcClock` (`orchestrator-
      // runtime.ts`) stamps `leaseExpiresAt` with, so `requireRunToken`'s
      // lease-expiry check is never independently skewed from it.
      now: () => new Date(),
      // Lazy: this context is built on every /api/work/v1/* request, most
      // of which (/items, /schedules) never reach a run-token route and so
      // never call `tokenFor`. Constructing `createDispatchTokenProvider`
      // eagerly here would fail-fast on missing `AGENT_LCARS_APP_*`
      // credentials for those requests too -- see
      // `lazyDispatchTokenProvider`'s own comment.
      tokens: lazyDispatchTokenProvider(() =>
        createDispatchTokenProvider(process.env),
      ),
      checkoutTokens: lazyDispatchTokenProvider(() =>
        createDispatchTokenProvider(process.env, DIRECT_RUNNER_PERMISSIONS),
      ),
      codexAuth: codexAuthStore('agent-lcars-codex-auth'),
      // Default-off staging gate: direct Codex cannot use auth until hosted
      // lanes are deliberately moved onto the same global lease authority.
      codexSharedLeaseEnabled:
        process.env['LCARS_CODEX_SHARED_LEASE_ENABLED'] === 'true',
    },
  });
  if (runsResult.matched && runsResult.response !== undefined) {
    return withNoStore(runsResult.response);
  }

  const { matched, response } = await handler.handle(request, {
    prefix: PREFIX,
    context: {
      ...(principal === undefined ? {} : { principal }),
      runtime,
      sessionsFor: sessionsForRuns,
      getSessionDoc: sessionForResume,
      maxLiveRuns: workMaxLiveRuns(),
      scheduleStore: createScheduleStore(),
      grants: workGrants,
      now: () => new Date(),
    },
  });
  return withNoStore(
    matched && response !== undefined
      ? response
      : Response.json({ error: 'Not found' }, { status: 404 }),
  );
}

/** Every response this route answers with is per-caller, credential-gated
 *  data (an item's live state, a run-token secret, a 401) -- never safe for
 *  a shared HTTP cache to reuse across callers. Matches every `api/control-
 *  plane/*` route's own `Cache-Control: no-store` header. Wrapping the
 *  final `Response` here (both the runs-router and items/schedules
 *  branches) is simpler than threading a header through oRPC's own
 *  `OpenAPIHandler`, which has no hook for adding one to every response it
 *  produces. */
function withNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
export const PATCH = handle;
