import { isTrue } from '@repo/util-server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

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

/**
 * Lightweight session check for the Edge runtime.
 *
 * We cannot use `auth()` from `../auth` here because it (transitively, via
 * `@repo/util-server`) touches Node.js-only APIs that are incompatible with
 * the Edge runtime where Next.js proxy code runs.
 *
 * Instead, we check for the presence of the Auth.js session cookie. This is
 * sufficient to redirect unauthenticated users; the actual session validity
 * and admin check are always verified server-side via `auth()` in
 * page/action code.
 *
 * Auth.js sets one of these cookies depending on the environment:
 * - `authjs.session-token`       (development / HTTP)
 * - `__Secure-authjs.session-token` (production / HTTPS)
 *
 * @see https://authjs.dev/getting-started/session-management/protecting
 */
function hasSessionCookie(request: NextRequest): boolean {
  const cookies = request.cookies.getAll();
  return cookies.some(
    (c) =>
      c.name.startsWith('authjs.session-token') ||
      c.name.startsWith('__Secure-authjs.session-token'),
  );
}

export default function proxy(request: NextRequest) {
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

  if (process.env.SKIP_AUTH_FOR_LAN_PREVIEW === 'true') {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // /login itself must stay reachable unauthenticated, or redirecting there
  // would loop forever.
  if (pathname === '/login') {
    return NextResponse.next();
  }

  // If no session cookie, redirect to our own sign-in page.
  if (!hasSessionCookie(request)) {
    if (pathname.startsWith('/api')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}
