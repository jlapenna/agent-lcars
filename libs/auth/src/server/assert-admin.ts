import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';

/**
 * Page/layout admin guard (#2123 follow-up), replacing ~15 hand-rolled
 * `if (!session?.user?.isAdmin) redirect(...)` copies across members/
 * onecake/primes/agent-console admin pages and layouts. Mirrors
 * `assertOnboarding`'s calling convention (take an already-resolved
 * session, assert in place) rather than `createAdminAction`'s bind-then-call
 * factory shape, since page guards are typically one call per file rather
 * than many calls per module.
 *
 * For Server Actions and other mutation entry points, use
 * `createAdminAction()` instead — it throws rather than redirecting, which
 * is the right behavior mid-mutation rather than mid-render.
 *
 * @param session - The NextAuth session
 * @param redirectTo - Where to send non-admins. Defaults to '/'.
 */
export function assertAdmin(
  session: Session | null,
  redirectTo = '/',
): asserts session is Session & { user: { id: string } } {
  if (!session?.user?.isAdmin) {
    redirect(redirectTo);
  }
}
