import { expect, test } from '@playwright/test';

import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();

test.describe('/shuttlebay workspace', () => {
  test('keeps live runner status on its own top-level page', async ({
    page,
  }) => {
    await page.goto('/shuttlebay');

    await expect(page.getByRole('heading', { name: 'Shuttlebay' })).toHaveCount(
      1,
    );
    await expect(
      page.getByText('Refreshes automatically every 10 seconds.'),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Console sections' })
        .getByRole('link', { name: 'Shuttlebay' }),
    ).toHaveAttribute('aria-current', 'page');
  });
});
