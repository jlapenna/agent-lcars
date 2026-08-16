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
// raw-body HMACs. Task state is an explicitly public, read-only projection
// with the private attempt capability redacted.
// Exported (rather than kept inline in the createAuthProxy call below) so
// proxy.test.ts can iterate the real list instead of maintaining its own
// copy that can silently drift out of coverage as routes are added (#863).
// A missing entry here is exactly what left /api/control-plane/
// recovery-observation rejecting 100% of its callers since it shipped,
// until #885 fixed it - a hand-copied test list can't catch an entry that
// was never added to either list. (recovery-observation and
// completion/reconcile were retired in #1015 Wave 4 along with the legacy
// broker machinery they backed.)
export const publicRoutes = [
  '/login',
  '/api/logs/error',
  '/api/control-plane/completion',
  '/api/control-plane/reconcile',
  '/api/control-plane/webhook',
  '/api/control-plane/webhook/process',
  '/api/control-plane/webhook/probe',
];

export default createAuthProxy({
  publicRoutes,
  // Both routes are guarded by isE2eTesting() themselves (403 outside e2e);
  // they must be reachable without a session because the Playwright test
  // process calls them directly via fetch(), not through the browser page
  // that carries the X-e2e-auth-user header.
  publicPrefixes: [
    '/api/e2e/',
    '/api/control-plane/task-state/',
    '/api/quick-task-evidence/v1/',
  ],
});
