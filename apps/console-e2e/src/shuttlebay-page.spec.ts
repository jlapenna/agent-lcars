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
    // Shuttlebay used to be the one destination with no create button,
    // not by design: a `.lcars-command-utilities:has(...)` rule matched the
    // shared cluster instead of the mobile wrapper inside it and hid the
    // whole thing from 64em up (#1810).
    await expect(page.getByRole('button', { name: 'New work' })).toHaveCount(1);
  });

  test('keeps every console destination reachable on a narrow phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/shuttlebay');

    const header = page.locator(
      '.console-header[data-current="shuttlebay"]:not([data-streaming-fallback])',
    );
    await expect(header.getByRole('link', { name: 'Shuttlebay' })).toBeHidden();
    await expect(
      header.getByRole('heading', { name: 'Shuttlebay' }),
    ).toBeVisible();
    await expect(
      header.getByRole('button', { name: 'New work' }),
    ).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Bridge' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Agents' })).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: 'Sessions' }),
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Costs' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test('keeps the overflow menu available on a tablet command rail', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 1024 });
    await page.goto('/shuttlebay');

    const header = page.locator(
      '.console-header[data-current="shuttlebay"]:not([data-streaming-fallback])',
    );
    await expect(
      header.getByRole('link', { name: 'Shuttlebay' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Sessions' }),
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Costs' })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
