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
    // The three-var check (not NODE_ENV: the E2E suite runs the standalone
    // `next build` server, which is already NODE_ENV=production) mirrors
    // @repo/util-server's isOnGoogleCloud() inline, since importing that
    // package here isn't safe for this file's Edge Middleware runtime.
    // K_SERVICE/K_REVISION/CLOUD_RUN_JOB are Cloud Run container-contract
    // vars, reserved and non-overridable, present only on a real deployed
    // instance — this is a hard backstop against the bypass ever being
    // live in production, even if E2E_TESTING were mistakenly set on the
    // deployed service outside of apphosting.yaml — see the matching
    // guard in auth.ts's testSession().
    const onCloudRun =
      process.env['K_SERVICE'] !== undefined ||
      process.env['K_REVISION'] !== undefined ||
      process.env['CLOUD_RUN_JOB'] !== undefined;
    if (process.env['E2E_TESTING'] === 'true' && !onCloudRun && e2eUser) {
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
