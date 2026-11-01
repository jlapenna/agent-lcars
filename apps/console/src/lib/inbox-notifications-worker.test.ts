import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(
  existsSync(resolve(process.cwd(), 'apps/console/public'))
    ? resolve(process.cwd(), 'apps/console/public/inbox-notifications-sw.js')
    : resolve(process.cwd(), 'public/inbox-notifications-sw.js'),
  'utf8',
);

describe('actual notification worker click boundary', () => {
  it.each([
    [
      '/inbox?item=owner%2Frepo%231',
      'https://console.example/inbox?item=owner%2Frepo%231',
    ],
    ['https://evil.example/inbox?item=secret', 'https://console.example/inbox'],
    ['javascript:alert(1)', 'https://console.example/inbox'],
    ['/api/work?item=secret', 'https://console.example/inbox'],
    [
      '/inbox?item=x&redirect=https://evil.example',
      'https://console.example/inbox?item=x',
    ],
  ])(
    'opens only an internal authenticated Inbox link for %s',
    async (href, expected) => {
      const handlers: Record<string, (event: unknown) => unknown> = {};
      const openWindow = vi.fn().mockResolvedValue(undefined);
      runInNewContext(source, {
        URL,
        self: {
          location: { origin: 'https://console.example' },
          clients: { openWindow },
          skipWaiting: vi.fn(),
          addEventListener: (name: string, cb: (event: unknown) => unknown) => {
            handlers[name] = cb;
          },
        },
      });
      const close = vi.fn();
      let pending: Promise<unknown> | undefined;
      handlers.notificationclick({
        notification: { data: { href }, close },
        waitUntil: (promise: Promise<unknown>) => {
          pending = promise;
        },
      });
      await pending;
      expect(openWindow).toHaveBeenCalledWith(expected);
      expect(close).toHaveBeenCalledOnce();
      expect(Object.keys(handlers).sort()).toEqual([
        'install',
        'notificationclick',
        'push',
      ]);
    },
  );
});

describe('closed-tab push receiver', () => {
  it('rechecks live cookie and subscription, removes resolved candidates, and uses a generic preview', async () => {
    const handlers: Record<string, (event: unknown) => unknown> = {};
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        available: true,
        principalId: 'viewer',
        observedAt: Date.now(),
        decisions: [{ id: 'owner/repo#1', generation: 'current' }],
      }),
    });
    const self = {
      addEventListener: (
        name: string,
        handler: (event: unknown) => unknown,
      ) => {
        handlers[name] = handler;
      },
      registration: {
        pushManager: {
          getSubscription: async () => ({
            endpoint: 'https://fcm.googleapis.com/test',
          }),
        },
        showNotification,
      },
    };
    runInNewContext(source, {
      self,
      fetch,
      URLSearchParams,
      AbortSignal,
      Date,
    });
    async function push(
      principalId = 'viewer',
      attemptAt: unknown = Date.now(),
    ) {
      let done: Promise<unknown> = Promise.resolve();
      handlers.push({
        data: {
          json: () => ({
            principalId,
            attemptAt,
            decisions: [
              { id: 'owner/repo#1', generation: 'current' },
              { id: 'resolved', generation: 'old' },
            ],
          }),
        },
        waitUntil: (promise: Promise<unknown>) => {
          done = promise;
        },
      });
      await done;
    }
    await push();
    expect(showNotification).toHaveBeenCalledWith('Agent LCARS', {
      body: 'A new human decision is available. Open the Inbox to review.',
      tag: 'lcars-inbox-push',
      data: { href: '/inbox?item=owner%2Frepo%231' },
    });
    showNotification.mockClear();
    await push('previous-user');
    await push('viewer', 'not-a-timestamp');
    fetch.mockResolvedValue({ ok: false } as never);
    await push();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it.each([
    ['behind', 5 * 60_000],
    ['ahead of', -5 * 60_000],
  ])(
    'displays a server-fresh push when the device clock runs %s the server',
    async (_direction, skew) => {
      // The server clock is `skew` ms ahead of this device's clock.
      const handlers: Record<string, (event: unknown) => unknown> = {};
      const showNotification = vi.fn().mockResolvedValue(undefined);
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          available: true,
          principalId: 'viewer',
          observedAt: Date.now() + skew,
          decisions: [{ id: 'owner/repo#1', generation: 'current' }],
        }),
      });
      runInNewContext(source, {
        self: {
          addEventListener: (
            name: string,
            handler: (event: unknown) => unknown,
          ) => {
            handlers[name] = handler;
          },
          registration: {
            pushManager: {
              getSubscription: async () => ({
                endpoint: 'https://fcm.googleapis.com/test',
              }),
            },
            showNotification,
          },
        },
        fetch,
        URLSearchParams,
        AbortSignal,
        Date,
      });
      const attemptAt = Date.now() + skew;
      let done: Promise<unknown> = Promise.resolve();
      handlers.push({
        data: {
          json: () => ({
            principalId: 'viewer',
            attemptAt,
            expiresAt: attemptAt + 60000,
          }),
        },
        waitUntil: (promise: Promise<unknown>) => {
          done = promise;
        },
      });
      await done;
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
        endpoint: 'https://fcm.googleapis.com/test',
        attemptAt,
      });
      expect(showNotification).toHaveBeenCalledOnce();
    },
  );
});
