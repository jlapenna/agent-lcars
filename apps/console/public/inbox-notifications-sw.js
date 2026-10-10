/* This worker only handles clicks. It never caches authenticated responses,
 * subscribes to push, receives issue bodies or emits autonomous messages. */
self.addEventListener('install', (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('/inbox', self.location.origin);
  try {
    const supplied = new URL(
      event.notification.data?.href,
      self.location.origin,
    );
    if (
      supplied.origin === self.location.origin &&
      supplied.pathname === '/inbox'
    ) {
      const item = supplied.searchParams.get('item');
      if (item && item.length <= 200) target.searchParams.set('item', item);
    }
  } catch {
    /* A malformed link opens the authenticated Inbox. */
  }
  event.waitUntil(self.clients.openWindow(target.href));
});
