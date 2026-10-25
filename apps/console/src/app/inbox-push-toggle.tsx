'use client';

import { Button, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

import {
  NOTIFICATION_MODE_LOCK,
  NOTIFICATION_SCOPE,
  NOTIFICATION_WORKER,
} from '../lib/inbox-notifications';
import {
  disableInboxPush,
  enableInboxPush,
  inboxPushStatus,
} from './inbox-push-actions';

/** No permission prompt, worker registration or subscription until a click. */
export function InboxPushToggle({
  principalId,
  disableOpenTab,
}: {
  principalId: string;
  disableOpenTab: () => Promise<boolean>;
}) {
  const mounted = useRef(true);
  const controlEpoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Background notifications off');
  useEffect(() => {
    let active = true;
    const observedEpoch = controlEpoch.current;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    void navigator.serviceWorker
      .getRegistration(NOTIFICATION_SCOPE)
      .then(async (registration) => {
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription) return;
        const result = await inboxPushStatus(subscription.endpoint);
        if (active && observedEpoch === controlEpoch.current) {
          setEnabled(result.enabled);
          setStatus(
            result.enabled
              ? 'Background notifications on for 30 days'
              : 'Background notifications off',
          );
        }
      })
      .catch(() => {
        if (active && observedEpoch === controlEpoch.current)
          setStatus('Background notifications unavailable');
      });
    return () => {
      active = false;
    };
  }, [principalId]);

  async function toggle() {
    if (
      !window.isSecureContext ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window) ||
      !('locks' in navigator)
    ) {
      setStatus('Background notifications unsupported in this browser');
      return;
    }
    ++controlEpoch.current;
    const permissionRequest = enabled
      ? Promise.resolve('granted')
      : Notification.requestPermission();
    setBusy(true);
    try {
      await navigator.locks.request(NOTIFICATION_MODE_LOCK, async () => {
        if (!mounted.current) return;
        if (enabled) {
          const registration =
            await navigator.serviceWorker.getRegistration(NOTIFICATION_SCOPE);
          const subscription =
            await registration?.pushManager.getSubscription();
          if (subscription) {
            // Revoke server consent before browser cleanup; failed cleanup cannot deliver.
            await disableInboxPush(subscription.endpoint, principalId);
            const notices = await registration?.getNotifications({
              tag: 'lcars-inbox-push',
            });
            for (const notice of notices ?? []) notice.close();
            await subscription.unsubscribe();
          }
          setEnabled(false);
          setStatus('Background notifications off');
          return;
        }
        // Start permission directly inside this gesture (Safari requires it).
        if ((await permissionRequest) !== 'granted') {
          setStatus('Notifications not permitted — check browser settings');
          return;
        }
        const config = await inboxPushStatus();
        if (!config.publicKey) throw new Error('Delivery unavailable');
        const registration = await navigator.serviceWorker.register(
          NOTIFICATION_WORKER,
          { scope: NOTIFICATION_SCOPE },
        );
        if (!registration.active) {
          const worker = registration.installing ?? registration.waiting;
          if (!worker) throw new Error('Worker unavailable');
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              worker.removeEventListener('statechange', changed);
              reject(new Error('Worker unavailable'));
            }, 5000);
            const changed = () => {
              if (
                worker.state === 'activated' ||
                worker.state === 'redundant'
              ) {
                clearTimeout(timeout);
                worker.removeEventListener('statechange', changed);
                if (worker.state === 'activated') resolve();
                else reject(new Error('Worker unavailable'));
              }
            };
            worker.addEventListener('statechange', changed);
            changed();
          });
        }
        const existing = await registration.pushManager.getSubscription();
        const subscription =
          existing ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: config.publicKey,
          }));
        if (!mounted.current || !(await disableOpenTab()))
          throw new Error('Mode switch unavailable');
        await enableInboxPush(subscription.toJSON(), principalId);
        setEnabled(true);
        setStatus('Background notifications on for 30 days');
      });
    } catch {
      setStatus('Background notifications unavailable — try again');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <Button
        variant="subtle"
        size="compact-sm"
        disabled={busy}
        onClick={() => void toggle()}
      >
        {enabled
          ? 'Disable background notifications'
          : 'Enable background notifications'}
      </Button>
      <Text
        size="xs"
        c="dimmed"
        role="status"
        aria-label="Background notification status"
      >
        {status}
      </Text>
      <Text size="xs" c="dimmed">
        This browser, all repositories, including when Inbox tabs are closed.
        Generic previews; sign-in must remain valid. Browser or OS settings may
        suppress delivery.
      </Text>
    </div>
  );
}
