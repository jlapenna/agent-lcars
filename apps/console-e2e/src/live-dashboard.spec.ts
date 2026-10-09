import { expect, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, usePopulatedFixtures } from './seed';
import {
  cachedConsoleSession,
  startCachedConsole,
} from './util/cached-console';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  finishDashboardRun,
  updateDashboardAnchor,
} from './util/orchestrator-seed';

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('live authoritative dashboards', () => {
  for (const { route, issue } of [
    { route: '/', issue: E2E_ITEM_NUMBERS.postDeploy },
    { route: '/inbox', issue: E2E_ITEM_NUMBERS.humanNeeded },
    { route: '/agents', issue: E2E_ITEM_NUMBERS.readyForAgent },
  ]) {
    test(`durable changes reach an already-open ${route} with scope intact`, async ({
      page,
    }) => {
      const url = `${route}?repo=supersprinklesracing%2Fsprinkles`;
      await page.goto(url);
      await expect(page.getByTestId('live-dashboard-status')).toHaveText(
        /Live updates connected/,
        { timeout: 20_000 },
      );
      const title = `Durable live update on ${route}`;
      await updateDashboardAnchor({ issue, title });
      await expect(page.getByText(title, { exact: false }).first()).toBeVisible(
        {
          timeout: 20_000,
        },
      );
      await expect(page).toHaveURL(
        new RegExp('repo=supersprinklesracing%2Fsprinkles'),
      );
      // Removal retains its timestamp even though the projection is gone.
      await updateDashboardAnchor({ issue, remove: true });
      await expect(page.getByText(title, { exact: false })).toHaveCount(0, {
        timeout: 20_000,
      });
    });
  }

  test('reconnect catches missed changes and shows a disconnected warning', async ({
    page,
  }) => {
    let first = true;
    let reconnectAllowed = false;
    await page.route('**/api/dashboard/stream', async (route) => {
      if (first) {
        first = false;
        // A bounded stream ending is a real EventSource EOF/error, unlike
        // setOffline which Chromium need not apply to an existing socket.
        await route.fulfill({
          contentType: 'text/event-stream',
          body: 'event: dashboard\ndata: {"state":"live","changed":false}\n\n',
        });
      } else if (reconnectAllowed) {
        await route.continue({
          headers: {
            ...route.request().headers(),
            'X-e2e-auth-user': 'e2e-agent-lcars-admin',
          },
        });
      } else await route.abort();
    });
    await page.goto('/inbox');
    await expect(page.getByTestId('live-dashboard-status')).toContainText(
      'Disconnected',
      { timeout: 20_000 },
    );
    await updateDashboardAnchor({
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      title: 'Changed while disconnected',
    });
    reconnectAllowed = true;
    await expect(
      page.getByText('Changed while disconnected', { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('live-dashboard-status')).toHaveText(
      /Live updates connected/,
    );
  });

  test('a durable run outcome reaches already-open Agents occupancy', async ({
    page,
  }) => {
    await page.goto('/agents?repo=supersprinklesracing%2Fsprinkles');
    await expect(page.getByTestId('live-dashboard-status')).toHaveText(
      /Live updates connected/,
      { timeout: 20_000 },
    );
    await expect(
      page.getByText('Queue: 2 queued, 0 claimed, 1 running'),
    ).toBeVisible();
    await finishDashboardRun();
    await expect(
      page.getByText('Queue: 1 queued, 0 claimed, 1 running'),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('preserves selected native reply text and focus while another durable decision changes', async ({
    page,
    request,
  }) => {
    expect(
      (
        await request.post('/api/e2e/seed', { data: { action: 'seed-inbox' } })
      ).ok(),
    ).toBe(true);
    const id = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
    const url = `/inbox?repo=supersprinklesracing%2Fsprinkles&item=work%3A${id}&sort=newest`;
    await page.goto(url);
    await expect(page.getByTestId('live-dashboard-status')).toHaveText(
      /Live updates connected/,
      { timeout: 20_000 },
    );
    const draft = page.getByRole('textbox', { name: 'Reply to the agent' });
    await draft.fill('Keep this unsent reply.');
    await updateDashboardAnchor({
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      title: 'A different decision changed',
    });
    await expect(
      page.getByText('A different decision changed', { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(draft).toHaveValue('Keep this unsent reply.');
    await expect(draft).toBeFocused();
    await expect(page).toHaveURL(url);
  });

  test('does not transfer a default draft when another operator answers its decision', async ({
    page,
    request,
  }) => {
    expect(
      (await request.post('/api/e2e/seed', { data: { action: 'reset' } })).ok(),
    ).toBe(true);
    expect(
      (
        await request.post('/api/e2e/seed', {
          data: { action: 'seed-inbox-only' },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/inbox');
    await expect(page.getByTestId('live-dashboard-status')).toHaveText(
      /Live updates connected/,
      { timeout: 20_000 },
    );
    const draft = page.getByRole('textbox', { name: 'Reply to the agent' });
    await draft.fill('Do not transfer this to another decision.');
    const answered = await request.post(
      '/api/work/v1/items/01J5Z3K9QX8F0N2B4V6C8D1E3G/reply',
      {
        headers: { 'X-e2e-auth-user': 'e2e-agent-lcars-admin' },
        data: { text: 'Another operator answered' },
      },
    );
    expect(answered.ok()).toBe(true);
    await expect(
      page.getByText(
        'The selected item left the queue. Your pending reply is preserved.',
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(draft).toHaveValue(
      'Do not transfer this to another decision.',
    );
    await expect(draft).toBeFocused();
    await expect(
      page.getByRole('button', { name: 'Reply', exact: true }),
    ).toBeDisabled();
    await draft.fill('');
    await expect(
      page.getByText('Your pending reply is preserved.', { exact: false }),
    ).toHaveCount(0);
  });

  test('denies stream access without the admin session', async ({
    request,
  }) => {
    const denied = await request.get('/api/dashboard/stream');
    expect(denied.status()).toBe(401);
    expect(denied.headers()['content-type']).not.toContain('text/event-stream');
  });
});

// This sibling process uses real Auth.js cookies and Next's production cache,
// with the fixture adapter DISABLED. It stays inside the hermetic emulator
// boundary: no runtime override, credential or extra API surface in the app.
test('live updates expire the actual production persistent cache', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const server = await startCachedConsole();
  try {
    await page.context().addCookies([await cachedConsoleSession(server.url)]);
    const session = await page.request.get(`${server.url}/api/auth/session`);
    expect((await session.json()).user.isAdmin).toBe(true);
    // The sibling cannot use the E2E auth or seed adapter.
    expect(
      (
        await request.post(`${server.url}/api/e2e/seed`, {
          data: { action: 'reset' },
        })
      ).status(),
    ).toBe(403);
    let allowStream = false;
    await page.route('**/api/dashboard/stream', async (route) => {
      if (allowStream) await route.continue();
      else await route.abort();
    });
    await page.goto(
      `${server.url}/inbox?repo=supersprinklesracing%2Fsprinkles`,
    );
    const row = page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`);
    await expect(row).toBeVisible();
    const before = await row.textContent();
    await updateDashboardAnchor({
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      title: 'Production cached evidence changed',
    });
    await page.reload();
    // A real persistent-cache hit still serves the old projection. This
    // assertion would fail if the test accidentally selected the E2E bypass.
    await expect(row).toHaveText(before ?? '');
    allowStream = true;
    await expect(row).toContainText('Production cached evidence changed', {
      timeout: 30_000,
    });
    // Another request sees the expired tag as well, not only this tab's RSC.
    const second = await page.context().newPage();
    await second.route('**/api/dashboard/stream', (route) => route.abort());
    await second.goto(`${server.url}/inbox`);
    await expect(
      second.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toContainText('Production cached evidence changed');
    await second.close();
  } finally {
    await page.goto('about:blank');
    await server.stop();
  }
});
