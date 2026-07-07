import {
  isE2eTesting,
  isImpersonate,
  isImpersonateAutomaticLogin,
  isMockAuthEnabled,
  isTrue,
} from '@repo/util-server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Header carrying the e2e test session (see `@repo/auth/server`'s
 * test-session adapter). The middleware forwards it downstream so server
 * components and route handlers can resolve the injected identity.
 */
const E2E_AUTH_USER_HEADER = 'X-e2e-auth-user';

const LOGIN_ROUTE = '/login';

export interface AuthProxyOptions {
  /**
   * Exact pathnames that never require authentication
   * (e.g. `'/login'`, `'/api/e2e/seed'`).
   */
  publicRoutes?: string[];
  /**
   * Pathname prefixes that never require authentication. Invite links arrive
   * from email before the user has ever signed in, so e.g. `'/invite/'` is
   * public.
   */
  publicPrefixes?: string[];
  /**
   * Inverts the gating model: when set, ONLY paths matching one of these
   * patterns require authentication and everything else is public (primes).
   * `publicRoutes`/`publicPrefixes` are ignored in this mode.
   */
  protectedPatterns?: RegExp[];
  /**
   * Routes an already-authenticated user is redirected away from (to `/`),
   * e.g. `'/login'`, `'/register'`. Only used with `protectedPatterns`.
   */
  loggedOutOnlyRoutes?: string[];
  /**
   * Append `?redirect=<pathname>` to the login redirect so the app can
   * return the user to where they were headed.
   */
  loginRedirectParam?: boolean;
}

/**
 * Lightweight session check for the Edge runtime.
 *
 * We cannot use `auth()` here because it depends on Firebase Admin SDK,
 * which is Node.js-only and incompatible with the Edge runtime where
 * Next.js middleware runs.
 *
 * Instead, we check for the presence of the Auth.js session cookie. This is
 * sufficient to redirect unauthenticated users; the actual session validity is
 * always verified server-side in page/layout components via `auth()`.
 *
 * Auth.js sets one of these cookies depending on the environment:
 * - `authjs.session-token`       (development / HTTP)
 * - `__Secure-authjs.session-token` (production / HTTPS)
 * (plus the legacy `next-auth.session-token` names from NextAuth v4)
 *
 * @see https://authjs.dev/getting-started/session-management/protecting
 */
function hasSessionCookie(request: NextRequest): boolean {
  if (isMockAuthEnabled()) {
    if (isImpersonateAutomaticLogin() || isImpersonate()) {
      return true;
    }
  }

  const cookies = request.cookies.getAll();
  return cookies.some(
    (c) =>
      c.name.startsWith('authjs.session-token') ||
      c.name.startsWith('__Secure-authjs.session-token') ||
      c.name.startsWith('next-auth.session-token') ||
      c.name.startsWith('__Secure-next-auth.session-token'),
  );
}

/**
 * During e2e runs, tests inject their identity via the `X-e2e-auth-user`
 * header (Playwright route interception). The middleware forwards the header
 * downstream and skips cookie gating entirely — the header IS the session,
 * and the server-side test-session adapter interprets it (including the
 * literal value `'unauthed'`, which simulates a logged-out user).
 */
function forwardE2eAuthUser(request: NextRequest): NextResponse | undefined {
  if (!isE2eTesting()) {
    return undefined;
  }
  const e2eAuthUser = request.headers.get(E2E_AUTH_USER_HEADER);
  if (!e2eAuthUser) {
    return undefined;
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(E2E_AUTH_USER_HEADER, e2eAuthUser);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * Builds the app's Edge middleware. Two gating models are supported:
 *
 * - **Public-allowlist** (members, onecake, agent-console): everything
 *   requires a session except `publicRoutes`/`publicPrefixes`; API paths get
 *   a 401, pages redirect to `/login`.
 * - **Protected-allowlist** (`protectedPatterns`; primes): only matching
 *   paths require a session, everything else is public, and
 *   `loggedOutOnlyRoutes` bounce authenticated users back to `/`.
 */
export function createAuthProxy(options: AuthProxyOptions = {}) {
  const {
    publicRoutes = [],
    publicPrefixes = [],
    protectedPatterns,
    loggedOutOnlyRoutes = [],
    loginRedirectParam = false,
  } = options;

  return function proxy(request: NextRequest): NextResponse {
    if (isTrue('MAINTENANCE_MODE')) {
      if (request.nextUrl.pathname.startsWith('/api')) {
        return NextResponse.json(
          { error: 'System is under maintenance. Please try again later.' },
          { status: 503 },
        );
      }
      return new NextResponse(
        'System is under maintenance. Please try again later.',
        { status: 503 },
      );
    }

    const e2eForward = forwardE2eAuthUser(request);
    if (e2eForward) {
      return e2eForward;
    }

    const { pathname } = request.nextUrl;
    const loggedIn = hasSessionCookie(request);

    if (protectedPatterns) {
      if (loggedIn && loggedOutOnlyRoutes.includes(pathname)) {
        return NextResponse.redirect(new URL('/', request.nextUrl.origin));
      }
      if (!loggedIn && protectedPatterns.some((p) => p.test(pathname))) {
        return redirectToLogin(request, loginRedirectParam);
      }
      return NextResponse.next();
    }

    if (
      publicRoutes.includes(pathname) ||
      publicPrefixes.some((prefix) => pathname.startsWith(prefix))
    ) {
      return NextResponse.next();
    }

    if (!loggedIn) {
      if (pathname.startsWith('/api')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return redirectToLogin(request, loginRedirectParam);
    }

    return NextResponse.next();
  };
}

function redirectToLogin(
  request: NextRequest,
  includeRedirectParam: boolean,
): NextResponse {
  const loginUrl = new URL(LOGIN_ROUTE, request.nextUrl.origin);
  if (includeRedirectParam) {
    loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
  }
  return NextResponse.redirect(loginUrl);
}
