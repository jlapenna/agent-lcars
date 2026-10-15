import { expect, type Page, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import {
  E2E_ADMIN_GITHUB_LOGIN,
  useE2eAdminBeforeEach,
} from './util/e2e-test-utils';

useE2eAdminBeforeEach();
usePopulatedFixtures();

/** The opt-in lives under Preferences in the console menu; delivery runs
 * while the Inbox page is open. */
async function openPreferences(page: Page) {
  // Open the menu once the Inbox's delivery watch is live (hydrated, not just
  // streamed); the menu-before-Inbox race is pinned by the unit tests.
  // A streamed handoff can briefly hold two copies of the marker.
  await expect(
    page
      .locator('[data-testid="inbox-notifications-watch"][data-active]')
      .first(),
  ).toBeAttached();
  await page
    .locator('button[aria-label="More console options"]:visible')
    .first()
    .click();
  const control = page.getByTestId('inbox-notifications');
  await expect(control).toBeVisible();
  return control;
}

async function installNotificationStub(page: Page) {
  await page.addInitScript(() => {
    const counters = { permission: 0, registered: 0, delivered: 0 };
    const requests: { title: string; href: string }[] = [];
    Object.assign(window, {
      notificationCounters: counters,
      notificationRequests: requests,
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: {
        permission: 'granted',
        requestPermission: async () => {
          counters.permission++;
          return 'granted';
        },
      },
    });
    const registration = {
      active: {},
      showNotification: async (
        title: string,
        options: { data: { href: string } },
      ) => {
        counters.delivered++;
        requests.push({ title, href: options.data.href });
      },
      getNotifications: async () => [],
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: async () => {
          counters.registered++;
          return registration;
        },
        getRegistration: async () => registration,
      },
    });
  });
}

async function notificationCounters(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          notificationCounters: {
            permission: number;
            registered: number;
            delivered: number;
          };
        }
      ).notificationCounters,
  );
}

async function notificationRequests(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          notificationRequests: { title: string; href: string }[];
        }
      ).notificationRequests,
  );
}

/** Hold Inbox RSC GETs and refresh server actions until the context closes.
 * Plain authenticated notification GETs still use the normal server route. */
async function holdRscRefreshes(page: Page) {
  await page.route('**/*', (route) => {
    const request = route.request();
    const headers = request.headers();
    if (
      new URL(request.url()).pathname === '/inbox' &&
      ((request.method() === 'GET' && headers['rsc'] === '1') ||
        (request.method() === 'POST' && headers['next-action']))
    )
      return;
    return route.fallback();
  });
}

/** Actual authenticated RSC/GET read, fake browser delivery. Never send
 * OS notifications from CI or mint a real notification subscription. */
for (const width of [390, 768, 1280]) {
  test(`opts in and unsubscribes from Inbox notifications at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installNotificationStub(page);
    await page.goto('/inbox');
    let control = await openPreferences(page);
    const counters = () => notificationCounters(page);
    expect(await counters()).toEqual({
      permission: 0,
      registered: 0,
      delivered: 0,
    });
    // A temporary read outage must not undo the user's browser opt-in.
    await page.route('**/api/inbox-notifications', (route) =>
      route.fulfill({ status: 503, body: '{}' }),
    );
    await control
      .getByRole('button', { name: 'Enable Inbox notifications' })
      .click();
    await expect(control.getByRole('status')).toHaveText(
      'Authorization or data unavailable — notifications paused',
    );
    expect(await counters()).toEqual({
      permission: 1,
      registered: 1,
      delivered: 0,
    });
    await page.unroute('**/api/inbox-notifications');
    await page.reload();
    control = await openPreferences(page);
    await expect(control.getByRole('status')).toHaveText(
      'Watching for new human decisions',
    );
    // Consent survives a new document without asking permission again or
    // registering the worker again, and recovery never replays the backlog.
    expect(await counters()).toEqual({
      permission: 0,
      registered: 0,
      delivered: 0,
    });
    const button = control.getByRole('button', {
      name: 'Disable Inbox notifications',
    });
    const bounds = await button.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await button.click();
    await expect(control.getByRole('status')).toHaveText('Notifications off');
    await expect(
      control.getByRole('button', { name: 'Enable Inbox notifications' }),
    ).toBeVisible();
    // APIRequestContext does not traverse the browser's page.route admin
    // adapter. Keep the anonymous gate visible, then authenticate the asset
    // read explicitly instead of accepting a followed login redirect.
    const anonymous = await page.request.get('/inbox-notifications-sw.js', {
      maxRedirects: 0,
    });
    expect(anonymous.status()).toBe(307);
    expect(
      new URL(anonymous.headers()['location'], anonymous.url()).pathname,
    ).toBe('/login');

    const worker = await page.request.get('/inbox-notifications-sw.js', {
      headers: { 'X-e2e-auth-user': E2E_ADMIN_GITHUB_LOGIN },
      maxRedirects: 0,
    });
    expect(worker.status()).toBe(200);
    expect(new URL(worker.url()).pathname).toBe('/inbox-notifications-sw.js');
    expect(worker.headers()['content-type']).toMatch(
      /^(?:application|text)\/javascript\b/,
    );
    expect(await worker.text()).toContain(
      "self.addEventListener('notificationclick'",
    );
  });
}

/** Exercise the real authenticated GET and existing emulator-only seed actions.
 * Block RSC refreshes so only the independent observer can discover the change.
 * Notification permission, registration and delivery remain explicit stubs. */
test('discovers new and reopened decisions while Inbox RSC refreshes are blocked', async ({
  page,
  request,
}) => {
  // Three 30-second production polls cover arrival, disappearance and reopening.
  // A rate-limit edge can defer the second delivery to a fourth poll: 120 seconds
  // plus 30 seconds for authenticated reads and fixture writes, without retries
  // or changing the application interval, clock or one-minute delivery limit.
  test.setTimeout(150_000);
  await installNotificationStub(page);
  await page.goto('/inbox');
  const control = await openPreferences(page);
  await holdRscRefreshes(page);
  await control
    .getByRole('button', { name: 'Enable Inbox notifications' })
    .click();
  await expect(control.getByRole('status')).toHaveText(
    'Watching for new human decisions',
  );
  expect(await notificationCounters(page)).toEqual({
    permission: 1,
    registered: 1,
    delivered: 0,
  });

  const decision = 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G';
  const nextSnapshot = (present: boolean) =>
    page.waitForResponse(
      async (response) => {
        if (
          !response.url().endsWith('/api/inbox-notifications') ||
          response.request().method() !== 'GET' ||
          response.status() !== 200
        )
          return false;
        const snapshot = (await response.json()) as {
          available: boolean;
          decisions: { id: string }[];
        };
        return (
          snapshot.available &&
          snapshot.decisions.some((item) => item.id === decision) === present
        );
      },
      { timeout: 40_000 },
    );
  const nativeRow = page.getByTestId(`queue-row-${decision}`);
  await expect(nativeRow).toHaveCount(0);

  const arrived = nextSnapshot(true);
  expect(
    (
      await request.post('/api/e2e/seed', {
        data: { action: 'seed-inbox-only' },
      })
    ).ok(),
  ).toBe(true);
  await arrived;
  await expect
    .poll(async () => (await notificationCounters(page)).delivered)
    .toBe(1);
  const target = {
    title: 'Agent LCARS',
    href: `/inbox?item=${encodeURIComponent(decision)}`,
  };
  expect(await notificationRequests(page)).toEqual([target]);
  await expect(nativeRow).toHaveCount(0);

  const absent = nextSnapshot(false);
  expect(
    (await request.post('/api/e2e/seed', { data: { action: 'reset' } })).ok(),
  ).toBe(true);
  await absent;
  await expect(control.getByRole('status')).toHaveText(
    'Watching for new human decisions',
  );
  expect((await notificationCounters(page)).delivered).toBe(1);

  const reopened = nextSnapshot(true);
  expect(
    (
      await request.post('/api/e2e/seed', {
        data: { action: 'seed-inbox-only' },
      })
    ).ok(),
  ).toBe(true);
  await reopened;
  await expect
    .poll(async () => (await notificationCounters(page)).delivered, {
      timeout: 40_000,
    })
    .toBe(2);
  expect(await notificationRequests(page)).toEqual([target, target]);
  await expect(nativeRow).toHaveCount(0);
  // The existing usePopulatedFixtures afterAll owns emulator fixture cleanup.
});
