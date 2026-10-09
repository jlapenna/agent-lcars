import { expect, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, usePopulatedFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import { updateDashboardAnchor } from './util/orchestrator-seed';

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('live authoritative dashboards', () => {
  for (const { route, issue } of [
    { route: '/', issue: E2E_ITEM_NUMBERS.postDeploy },
    { route: '/inbox', issue: E2E_ITEM_NUMBERS.humanNeeded },
    { route: '/agents', issue: E2E_ITEM_NUMBERS.humanNeeded },
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
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page).toHaveURL(
        new RegExp('repo=supersprinklesracing%2Fsprinkles'),
      );
      // Removal retains its timestamp even though the projection is gone.
      await updateDashboardAnchor({ issue, remove: true });
      await expect(page.getByText(title, { exact: true })).toHaveCount(0, {
        timeout: 20_000,
      });
    });
  }

  test('reconnect catches missed changes and shows a disconnected warning', async ({
    page,
  }) => {
    let refused = false;
    await page.route('**/api/dashboard/stream', async (route) => {
      if (refused) await route.abort();
      else
        await route.continue({
          headers: {
            ...route.request().headers(),
            'X-e2e-auth-user': 'e2e-agent-lcars-admin',
          },
        });
    });
    await page.goto('/inbox');
    await expect(page.getByTestId('live-dashboard-status')).toHaveText(
      /Live updates connected/,
      { timeout: 20_000 },
    );
    // Offline terminates the actual stream; reconnect must read fresh state.
    refused = true;
    await page.context().setOffline(true);
    await expect(page.getByTestId('live-dashboard-status')).toContainText(
      'Disconnected',
      { timeout: 20_000 },
    );
    await updateDashboardAnchor({
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      title: 'Changed while disconnected',
    });
    await page.context().setOffline(false);
    refused = false;
    await expect(
      page.getByText('Changed while disconnected', { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('live-dashboard-status')).toHaveText(
      /Live updates connected/,
    );
  });

  test('denies stream access without the admin session', async ({
    request,
  }) => {
    const denied = await request.get('/api/dashboard/stream');
    expect(denied.status()).toBe(401);
    expect(denied.headers()['content-type']).not.toContain('text/event-stream');
  });
});
