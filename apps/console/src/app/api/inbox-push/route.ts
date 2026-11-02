import { required } from '@agent-lcars/util-server';

import { auth } from '../../../auth';
import { isAdminGithubLogin } from '../../../lib/deployment';
import { notificationSnapshotFresh } from '../../../lib/inbox-notifications';
import { getInboxPushStore, pushSnapshot } from '../../../lib/inbox-push';

/** A woken worker rechecks subscription, cookie identity, grants and snoozes
 * before requesting a generic OS preview. Endpoints never enter URLs/logs.
 * The public origin is AUTH_URL: behind App Hosting, request.url carries the
 * internal Cloud Run host, which no browser Origin header ever matches. */
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (request.headers.get('origin') !== new URL(required('AUTH_URL')).origin)
    return new Response(null, { status: 403, headers });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        const session = await auth();
        if (
          !session?.user.id ||
          !session.user.isAdmin ||
          typeof session.user.login !== 'string' ||
          !isAdminGithubLogin(session.user.login)
        )
          throw new Error('Unauthorized');
        const raw = await request.text();
        if (raw.length > 4096) throw new Error('Invalid input');
        const { endpoint, attemptAt } = JSON.parse(raw) as {
          endpoint?: unknown;
          attemptAt?: unknown;
        };
        if (
          typeof attemptAt !== 'number' ||
          !Number.isFinite(attemptAt) ||
          typeof endpoint !== 'string' ||
          endpoint.length > 2048 ||
          !(await getInboxPushStore().status(session.user.id, endpoint))
        )
          throw new Error('Disabled');
        const snapshot = await pushSnapshot(
          session.user.id,
          session.user.login,
        );
        if (!notificationSnapshotFresh(snapshot, Date.now()))
          throw new Error('Unavailable');
        const candidates = await getInboxPushStore().receive(
          session.user.id,
          endpoint,
          attemptAt,
        );
        if (!candidates) throw new Error('Unavailable');
        return {
          ...snapshot,
          decisions: candidates.filter((decision) =>
            snapshot.decisions.some(
              (current) =>
                current.id === decision.id &&
                current.generation === decision.generation,
            ),
          ),
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Unavailable')), 5000);
      }),
    ]);
    return Response.json(result, { headers });
  } catch {
    return new Response(null, { status: 503, headers });
  } finally {
    clearTimeout(timer);
  }
}
