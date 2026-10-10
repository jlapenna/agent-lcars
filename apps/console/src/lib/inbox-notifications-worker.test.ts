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
      ]);
    },
  );
});
