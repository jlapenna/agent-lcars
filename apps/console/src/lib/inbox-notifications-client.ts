import type { InboxNotificationSnapshot } from './inbox-notifications';

/** Optional read-only polling must not enter Next's shared mutation queue. */
export async function readInboxNotificationSnapshot(): Promise<InboxNotificationSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch('/api/inbox-notifications', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Notification source unavailable');
    return (await response.json()) as InboxNotificationSnapshot;
  } finally {
    clearTimeout(timer);
  }
}
