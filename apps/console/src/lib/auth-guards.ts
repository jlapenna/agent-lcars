import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';

export function assertAdmin(
  session: Session | null,
  redirectTo = '/',
): asserts session is Session & { user: { id: string } } {
  if (!session?.user?.isAdmin) redirect(redirectTo);
}

export function createAdminAction(
  authenticate: () => Promise<Session | null>,
): () => Promise<Session & { user: { id: string } }> {
  return async () => {
    const session = await authenticate();
    if (!session?.user?.isAdmin) throw new Error('Unauthorized');
    return session as Session & { user: { id: string } };
  };
}
