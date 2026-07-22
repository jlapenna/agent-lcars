import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const SESSION_COOKIES = [
  'authjs.session-token',
  '__Secure-authjs.session-token',
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
];

export function createAuthProxy(
  options: { publicRoutes?: string[]; publicPrefixes?: string[] } = {},
) {
  const publicRoutes = options.publicRoutes ?? [];
  const publicPrefixes = options.publicPrefixes ?? [];
  return function proxy(request: NextRequest): NextResponse {
    if (process.env['MAINTENANCE_MODE'] === 'true') {
      return new NextResponse('System is under maintenance.', { status: 503 });
    }
    const e2eUser = request.headers.get('x-e2e-auth-user');
    if (process.env['E2E_TESTING'] === 'true' && e2eUser) {
      return NextResponse.next();
    }
    if (
      publicRoutes.includes(request.nextUrl.pathname) ||
      publicPrefixes.some((prefix) =>
        request.nextUrl.pathname.startsWith(prefix),
      )
    ) {
      return NextResponse.next();
    }
    const loggedIn = request.cookies
      .getAll()
      .some((cookie) =>
        SESSION_COOKIES.some((name) => cookie.name.startsWith(name)),
      );
    if (loggedIn) return NextResponse.next();
    if (request.nextUrl.pathname.startsWith('/api')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.nextUrl.origin));
  };
}
