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
  // The reconcile route performs stronger request authentication itself:
  // it verifies a GitHub Actions OIDC signature plus repository/workflow/
  // ref/event claims before doing any work. It cannot require a browser
  // session because the scheduled workflow is its caller.
  publicRoutes: ['/login', '/api/logs/error', '/api/control-plane/reconcile'],
  // Both routes are guarded by isE2eTesting() themselves (403 outside e2e);
  // they must be reachable without a session because the Playwright test
  // process calls them directly via fetch(), not through the browser page
  // that carries the X-e2e-auth-user header.
  publicPrefixes: ['/api/e2e/'],
});
