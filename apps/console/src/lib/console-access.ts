import 'server-only';

import type { Session } from 'next-auth';

import { isAdminGithubLogin } from './deployment';
import { resolvePrincipal } from './work-grants';

/** Browser admission is distinct from admin authority. Work operations
 * resolve this grant again on every request; no scope is stored in the JWT. */
export function isWorkOperatorLogin(login: unknown): boolean {
  return (
    typeof login === 'string' &&
    resolvePrincipal(`github:${login}`)?.scopes.includes('work.operator') ===
      true
  );
}

export function canSignInToConsole(login: unknown): boolean {
  return isAdminGithubLogin(login) || isWorkOperatorLogin(login);
}

export function consoleLandingPath(
  session: Session | null,
): string | undefined {
  if (session?.user?.isAdmin) return '/';
  if (isWorkOperatorLogin(session?.user?.login)) return '/work';
  return undefined;
}
