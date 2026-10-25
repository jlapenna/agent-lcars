import { MantineProvider } from '@mantine/core';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));
vi.mock('./inbox-push-actions', () => ({
  inboxPushStatus: mocks.status,
  enableInboxPush: mocks.enable,
  disableInboxPush: mocks.disable,
}));
import { InboxPushToggle } from './inbox-push-toggle';
const endpoint = 'https://fcm.googleapis.com/fcm/send/test';
const subscription = {
  endpoint,
  toJSON: () => ({ endpoint }),
  unsubscribe: vi.fn().mockResolvedValue(true),
};
const registration = {
  active: {},
  getNotifications: async () => [],
  pushManager: {
    getSubscription: async () => subscription,
    subscribe: async () => subscription,
  },
};
const disableOpenTab = vi.fn();
function tree(key: string) {
  return (
    <MantineProvider>
      <InboxPushToggle
        key={key}
        principalId="viewer"
        disableOpenTab={disableOpenTab}
      />
    </MantineProvider>
  );
}
describe('background notification consent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('PushManager', {});
    vi.stubGlobal('Notification', {
      requestPermission: vi.fn().mockResolvedValue('granted'),
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: async () => registration,
        register: async () => registration,
      },
    });
    const locks = new Map<string, Promise<unknown>>();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (key: string, fn: () => unknown) => {
          const next = (locks.get(key) ?? Promise.resolve()).then(fn);
          locks.set(
            key,
            next.catch(() => undefined),
          );
          return next;
        },
      },
    });
    mocks.status.mockResolvedValue({ enabled: false, publicKey: 'public' });
    disableOpenTab.mockResolvedValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it('ignores an initial status response that arrives after opt-in', async () => {
    let resolveStatus!: (value: {
      enabled: boolean;
      publicKey: string;
    }) => void;
    mocks.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    render(tree('first'));
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Enable background notifications' }),
      );
    });
    expect(
      screen.getByRole('button', { name: 'Disable background notifications' }),
    ).toBeTruthy();
    await act(async () => {
      resolveStatus({ enabled: false, publicKey: 'public' });
    });
    expect(
      screen.getByRole('button', { name: 'Disable background notifications' }),
    ).toBeTruthy();
  });
  it('does not activate background delivery when open-tab disable fails', async () => {
    disableOpenTab.mockResolvedValue(false);
    render(tree('first'));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Enable background notifications' }),
      );
    });
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(screen.getByText(/unavailable — try again/)).toBeTruthy();
  });
  it('serializes a delayed enable before another tab revokes consent', async () => {
    const order: string[] = [];
    let release!: () => void;
    mocks.enable.mockImplementation(async () => {
      order.push('enable-start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('enable-done');
    });
    mocks.disable.mockImplementation(async () => {
      order.push('disable');
    });
    render(tree('first'));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Enable background notifications' }),
      );
    });
    await waitFor(() => expect(order).toEqual(['enable-start']));
    mocks.status.mockResolvedValue({ enabled: true, publicKey: 'public' });
    render(tree('second'));
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Disable background notifications',
        }),
      ).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Disable background notifications',
        }),
      );
    });
    expect(mocks.disable).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(order).toEqual(['enable-start', 'enable-done', 'disable']),
    );
    expect(mocks.disable).toHaveBeenCalledWith(endpoint, 'viewer');
  });
});
