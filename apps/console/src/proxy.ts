import { createAuthProxy } from './lib/auth-proxy';

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - static assets (.svg, .png, .jpg, etc)
     * - /api/auth (Auth.js endpoints — must be accessible unauthenticated)
     */
    '/((?!_next/static|_next/image|api/auth|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)',
  ],
};

// These control-plane routes do not use browser sessions. Reconcile and
// completion verify GitHub Actions OIDC claims, while webhook verifies
// raw-body HMACs.
// Exported (rather than kept inline in the createAuthProxy call below) so
// proxy.test.ts can iterate the real list instead of maintaining its own
// copy that can silently drift out of coverage as routes are added (#863).
// A missing entry here is exactly what left /api/control-plane/
// recovery-observation rejecting 100% of its callers since it shipped,
// until #885 fixed it - a hand-copied test list can't catch an entry that
// was never added to either list. (recovery-observation and
// completion/reconcile were retired in #1015 Wave 4 along with the legacy
// broker machinery they backed.)
// #1232's /api/control-plane/request shipped without an entry in either
// list and 401ed every OIDC caller until it was caught here — the same
// failure mode again. proxy.test.ts now derives the required entries from
// the route files on disk, which is also what retired the stale
// webhook/probe entry (#885 deleted that route).
export const publicRoutes = [
  '/login',
  '/api/logs/error',
  '/api/control-plane/completion',
  '/api/control-plane/reconcile',
  '/api/control-plane/request',
  '/api/control-plane/webhook',
  '/api/control-plane/webhook/process',
];

// Exported for the same reason publicRoutes is: proxy.test.ts iterates the
// real list and derives what must appear in it from the route files on disk.
export const publicPrefixes = [
  // Both routes are guarded by isE2eTesting() themselves (403 outside e2e);
  // they must be reachable without a session because the Playwright test
  // process calls them directly via fetch(), not through the browser page
  // that carries the X-e2e-auth-user header.
  '/api/e2e/',
  '/api/quick-task-evidence/v1/',
  // Bearer-authenticated work API. Its 401 is the router-level `operator`
  // middleware in work-router.ts, not this cookie check: a service account
  // presenting a Google-signed ID token carries no session cookie, so
  // leaving it behind the gate would reject every machine caller with a
  // bare {"error":"Unauthorized"} before oRPC ever routed the request. The
  // route still reads an Auth.js session when no bearer is present, so a
  // console operator is authenticated exactly as before.
  '/api/work/v1',
];

export default createAuthProxy({
  publicRoutes,
  publicPrefixes,
});
