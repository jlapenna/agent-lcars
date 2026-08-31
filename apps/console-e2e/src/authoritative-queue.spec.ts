import { expect, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, usePopulatedFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('authoritative queue projection', () => {
  test('renders webhook-backed anchors on Bridge, Inbox, and Agents without a GitHub warning', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('data-warnings')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Bridge' })).toBeVisible();

    await page.goto('/inbox');
    await expect(page.getByTestId('data-warnings')).toHaveCount(0);
    await expect(
      page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toBeVisible();
    await expect(page.getByText('Human needed').first()).toBeVisible();

    await page.goto('/agents');
    await expect(page.getByTestId('data-warnings')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Agent Status' }),
    ).toBeVisible();
    await expect(
      page.getByText(`#${E2E_ITEM_NUMBERS.humanNeeded}`).first(),
    ).toBeVisible();
  });
});
