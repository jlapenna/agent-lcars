import { expect, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import {
  expectDesktopBridgeHeader,
  expectMobileBridgeHeader,
} from './util/console-layout';
import {
  E2E_ADMIN_GITHUB_LOGIN,
  useE2eAdminBeforeEach,
} from './util/e2e-test-utils';

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('/costs workspace @smoke', () => {
  test('uses the compact ledger hierarchy on desktop', async ({ page }) => {
    await page.goto('/costs');

    const header = page.locator(
      '.console-header[data-current="costs"]:not([data-streaming-fallback])',
    );
    const workspace = page.getByRole('region', { name: 'Cost ledger' });
    await expectDesktopBridgeHeader(header);
    await expect(workspace).toBeVisible();
    await expect(page.getByRole('button', { name: 'New work' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByTestId('session-ledger')).toBeVisible();
    await expect(page.getByTestId('spend-breakdowns')).toBeVisible();
    await expect(page.getByTestId('cost-budget-state')).toContainText(
      'No budget configured',
    );
    await expect(page.getByTestId('cost-per-deliverable')).toContainText(
      'per merged deliverable',
    );
    await expect(
      page.getByRole('region', { name: 'By pipeline' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'By requested model' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'By resolved model' }),
    ).toBeVisible();
    await expect(
      workspace.getByRole('region', { name: 'By issue' }),
    ).toBeVisible();
    await expect(
      workspace.getByRole('region', { name: 'By week' }),
    ).toBeVisible();

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test('opens with the fleet readouts, spend by repository and a ledger export', async ({
    page,
  }) => {
    await page.goto('/costs?days=30');
    const workspace = page.getByRole('region', { name: 'Cost ledger' });
    // The same readout row as the Bridge (design/fleet-console.html#costs).
    for (const id of ['online', 'busy', 'queue', 'running']) {
      await expect(workspace.getByTestId(`readout-${id}`)).toBeVisible();
    }
    await expect(workspace.getByTestId('readout-spend')).toContainText(
      'since 00:00 UTC · no daily budget',
    );
    const repos = workspace.getByTestId('spend-by-repository');
    await expect(repos).toContainText('Spend by repository');
    await expect(
      repos.getByRole('columnheader', { name: 'Sessions · 7d' }),
    ).toBeVisible();

    const exportLink = page.getByRole('link', { name: 'Export ledger' });
    await expect(exportLink).toHaveAttribute('href', '/costs/export?days=30');
    // The primary action sits outside the filter form, so it never submits it.
    await expect(
      page.getByRole('search', { name: 'Filters' }).getByRole('link', {
        name: 'Export ledger',
      }),
    ).toHaveCount(0);
    // APIRequestContext bypasses page.route's admin adapter; authenticate
    // the download explicitly, as the notification worker check does.
    const csv = await page.request.get('/costs/export?days=30', {
      headers: { 'X-e2e-auth-user': E2E_ADMIN_GITHUB_LOGIN },
      maxRedirects: 0,
    });
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect((await csv.text()).split('\n')[0]).toBe(
      'section,key,repository,sessions,turns,cost_weighted_tokens,cost_usd,cost_estimated',
    );
    const anonymous = await page.request.get('/costs/export', {
      maxRedirects: 0,
    });
    expect([307, 401]).toContain(anonymous.status());
  });

  test('uses the shared elbow header and flat essential mobile ledger rows', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/costs?days=30&source=issue-agent&issue=9005');

    const header = page.locator(
      '.console-header[data-current="costs"]:not([data-streaming-fallback])',
    );
    const workspace = page.getByRole('region', { name: 'Cost ledger' });
    await expect(header.getByRole('link', { name: 'Costs' })).toBeHidden();
    await expect(header.getByRole('link', { name: 'Bridge' })).toBeHidden();
    await expect(workspace).toBeVisible();
    await expect(page.getByTestId('ledger-issue-row-compact')).toBeVisible();
    await expect(page.getByTestId('ledger-week-row-compact')).toBeVisible();
    await expect(page.getByTestId('spend-breakdowns')).toBeVisible();
    await expect(page.getByRole('list', { name: 'By pipeline' })).toBeVisible();
    // Repository spend reflows into rows that keep the seven-day meter.
    const repos = page.getByRole('list', { name: 'Spend by repository' });
    await expect(repos).toBeVisible();
    await expect(
      repos.getByRole('img', { name: /of the largest repository/ }).first(),
    ).toBeVisible();
    await expectMobileBridgeHeader(header);

    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Bridge' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: 'Sessions' }),
    ).toHaveAttribute(
      'href',
      '/sessions?days=30&source=issue-agent&issue=9005',
    );
    await expect(menu.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');

    const undersizedControls = await page
      .locator(
        '.console-header[data-current="costs"] a:visible, .console-header[data-current="costs"] button:visible, .costs-workspace a:visible, .costs-workspace button:visible',
      )
      .evaluateAll((elements) =>
        elements
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              label:
                element.getAttribute('aria-label') ??
                element.textContent?.trim() ??
                element.tagName,
              width: box.width,
              height: box.height,
            };
          })
          .filter(({ width, height }) => width < 44 || height < 44),
      );
    expect(undersizedControls).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test('keeps the tablet command rail within the viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/costs?days=30');

    const header = page.locator(
      '.console-header[data-current="costs"]:not([data-streaming-fallback])',
    );
    await expect(header.getByRole('link', { name: 'Costs' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Bridge' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Inbox' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Agents' })).toBeVisible();
    await expect(
      header.getByRole('button', { name: 'More console options' }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
