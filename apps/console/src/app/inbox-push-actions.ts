'use server';

import { auth } from '../auth';
import { isAdminGithubLogin } from '../lib/deployment';
import { notificationSnapshotFresh } from '../lib/inbox-notifications';
import {
  getInboxPushStore,
  pushConfiguration,
  pushSnapshot,
  pushSubscriptionSchema,
} from '../lib/inbox-push';

async function viewer() {
  const session = await auth();
  if (
    !session?.user.id ||
    !session.user.isAdmin ||
    typeof session.user.login !== 'string' ||
    !isAdminGithubLogin(session.user.login)
  )
    throw new Error('Unauthorized');
  return { id: session.user.id, login: session.user.login };
}
export async function inboxPushStatus(endpoint?: string) {
  const user = await viewer();
  const config = pushConfiguration();
  return {
    publicKey: config?.publicKey,
    enabled: endpoint
      ? await getInboxPushStore().status(user.id, endpoint)
      : false,
  };
}
/** `paused` means the Inbox snapshot is incomplete or stale, so no quiet
 * baseline can be recorded. It is returned, not thrown, because production
 * redacts thrown Server Action messages and the viewer needs the reason. */
export async function enableInboxPush(
  input: unknown,
  expectedUserId: string,
): Promise<'enabled' | 'paused'> {
  const user = await viewer();
  if (!pushConfiguration())
    throw new Error('Background notifications unavailable');
  if (user.id !== expectedUserId) throw new Error('Account changed');
  const subscription = pushSubscriptionSchema.parse(input);
  const store = getInboxPushStore();
  const revision = await store.begin(user.id, user.login, subscription);
  try {
    const snapshot = await pushSnapshot(user.id, user.login);
    if (notificationSnapshotFresh(snapshot, Date.now())) {
      await store.activate(user.id, subscription.endpoint, revision, snapshot);
      return 'enabled';
    }
  } catch (error) {
    await store.remove(user.id, subscription.endpoint, revision);
    throw error;
  }
  await store.remove(user.id, subscription.endpoint, revision);
  return 'paused';
}
export async function disableInboxPush(
  endpoint: string,
  expectedUserId: string,
) {
  const user = await viewer();
  if (user.id !== expectedUserId) throw new Error('Account changed');
  if (typeof endpoint !== 'string' || endpoint.length > 2048)
    throw new Error('Invalid endpoint');
  await getInboxPushStore().remove(user.id, endpoint);
}
