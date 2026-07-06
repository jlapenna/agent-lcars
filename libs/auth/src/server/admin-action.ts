import type { Session } from 'next-auth';

/**
 * "Require admin" guard for Next.js Server Actions (#2123), replacing ~7
 * hand-rolled copies (`requireAdmin`/`ensureAdmin` in members/onecake/
 * agent-console) that had drifted in return type (void vs. Session vs. a
 * bare user id string) and error text ("Unauthorized" vs. "Not authorized").
 *
 * Each app still supplies its own `auth()` - members, onecake, and
 * agent-console each run a separate NextAuth config - so this is a factory,
 * not a single shared `auth()` call. Bind it once per actions module:
 *
 *   import { auth } from '@/auth';
 *   const adminAction = createAdminAction(auth);
 *
 *   export async function upsertThing(...) {
 *     await adminAction();
 *     ...
 *   }
 */
export function createAdminAction(
  auth: () => Promise<Session | null>,
): () => Promise<Session & { user: { id: string } }> {
  return async function adminAction() {
    const session = await auth();
    if (!session?.user?.isAdmin) {
      throw new Error('Unauthorized');
    }
    return session as Session & { user: { id: string } };
  };
}
