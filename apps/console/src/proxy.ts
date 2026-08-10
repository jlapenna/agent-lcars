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

export default createAuthProxy({
  // These control-plane routes do not use browser sessions. Reconcile and
  // completion verify GitHub Actions OIDC claims, while webhook and the queued
  // completion reconciler verify raw-body HMACs. Task state is an explicitly
  // public, read-only projection with the private attempt capability redacted.
  publicRoutes: [
    '/login',
    '/api/logs/error',
    '/api/control-plane/completion',
    '/api/control-plane/completion/reconcile',
    '/api/control-plane/reconcile',
    '/api/control-plane/webhook',
    '/api/control-plane/webhook/process',
    '/api/control-plane/webhook/probe',
  ],
  // Both routes are guarded by isE2eTesting() themselves (403 outside e2e);
  // they must be reachable without a session because the Playwright test
  // process calls them directly via fetch(), not through the browser page
  // that carries the X-e2e-auth-user header.
  publicPrefixes: ['/api/e2e/', '/api/control-plane/task-state/'],
});
