import NextAuth from 'next-auth';
import type { Session } from 'next-auth';

import { getMockSession, withImpersonation } from './auth';
import { AuthConfigOptions, getAuthConfig } from './config';
import { initWebLogging } from './logging-initialization';
import { getTestSession } from './test-session';

export interface CreateAppAuthOptions {
  /**
   * Options forwarded to `getAuthConfig()` — the app's provider list,
   * allowlists, and adapter mode. Pass a thunk when the options read
   * `required()` env accessors, so they are evaluated per request rather
   * than at module load (secret-less CI builds import `auth.ts`).
   */
  config?: AuthConfigOptions | (() => AuthConfigOptions);
  /**
   * App-specific mock-session shape for the test-session adapter and the
   * `/api/auth/session` impersonation override (e.g. members includes Slack
   * identity + onboarding; agent-console grants admin). Defaults to the
   * basic shared mock session.
   */
  mockSession?: (userId: string) => Promise<Session>;
}

/**
 * The one auth wiring shape for the Next.js apps (#2127). Each app's
 * `auth.ts` is a thin wrap:
 *
 * ```ts
 * export const { auth, handlers, signIn, signOut } = createAppAuth({
 *   config: { providers: ['strava'] },
 * });
 * ```
 *
 * Wires together `getAuthConfig()` (providers, adapter, callbacks), the
 * shared test-session adapter (e2e header + env impersonation), and the
 * `/api/auth/session` impersonation override that keeps the client-side
 * `useSession()` consistent with the server-side `auth()`.
 */
export function createAppAuth(options: CreateAppAuthOptions = {}) {
  const { mockSession = getMockSession, config } = options;

  initWebLogging();

  const {
    handlers: nextHandlers,
    auth: nextAuth,
    signIn,
    signOut,
  } = NextAuth(async () => {
    return await getAuthConfig(
      typeof config === 'function' ? config() : config,
    );
  });

  // Zero-arg `auth()` calls (server components, actions, route handlers)
  // consult the test-session adapter first; all other call shapes go
  // straight to NextAuth. NextAuth's `auth` is a multi-overload function,
  // so the wrapper widens the tuple to inspect the call shape.
  const auth: typeof nextAuth = (async (
    ...args: Parameters<typeof nextAuth>
  ) => {
    if ((args as readonly unknown[]).length === 0) {
      const testSession = await getTestSession({ mockSession });
      if (testSession !== undefined) {
        return testSession;
      }
    }
    return (
      nextAuth as (
        ...args: Parameters<typeof nextAuth>
      ) => ReturnType<typeof nextAuth>
    )(...args);
  }) as typeof nextAuth;

  const handlers = withImpersonation(nextHandlers, mockSession);

  return { auth, handlers, signIn, signOut };
}
