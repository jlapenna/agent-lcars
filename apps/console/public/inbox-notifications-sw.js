/* No authenticated response caching. Push carries identifiers only. */
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const payload = event.data?.json();
        if (
          !payload ||
          payload.expiresAt <= Date.now() ||
          payload.expiresAt > Date.now() + 60000
        )
          return;
        const subscription =
          await self.registration.pushManager.getSubscription();
        if (!subscription) return;
        const response = await fetch('/api/inbox-push', {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: subscription.endpoint,
            attemptAt: payload.attemptAt,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return;
        const snapshot = await response.json();
        if (
          !snapshot.available ||
          snapshot.principalId !== payload.principalId ||
          Date.now() - snapshot.observedAt >= 60000 ||
          snapshot.observedAt > Date.now() ||
          payload.expiresAt <= Date.now()
        )
          return;
        const current = snapshot.decisions;
        if (!current.length) return;
        const href =
          current.length === 1
            ? '/inbox?' + new URLSearchParams({ item: current[0].id })
            : '/inbox';
        await self.registration.showNotification('Agent LCARS', {
          body: 'A new human decision is available. Open the Inbox to review.',
          tag: 'lcars-inbox-push',
          data: { href },
        });
      } catch {
        /* A revoked, expired or unavailable source stays quiet. */
      }
    })(),
  );
});
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
