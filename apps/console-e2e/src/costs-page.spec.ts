import { expect, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('/costs workspace @smoke', () => {
  test('uses the compact ledger hierarchy on desktop', async ({
    page,
  }, testInfo) => {
    await page.goto('/costs');

    const header = page.locator('.console-header[data-current="costs"]');
    const workspace = page.getByRole('region', { name: 'Cost ledger' });
    await expect(header).toBeVisible();
    await expect(workspace).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Quick task' }),
    ).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByTestId('session-ledger')).toBeVisible();
    await expect(
      workspace.getByRole('region', { name: 'By issue' }),
    ).toBeVisible();
    await expect(
      workspace.getByRole('region', { name: 'By week' }),
    ).toBeVisible();

    expect((await header.boundingBox())?.height).toBeLessThanOrEqual(80);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const capture = testInfo.outputPath('costs-desktop.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('costs-desktop.png', {
      path: capture,
      contentType: 'image/png',
    });
  });

  test('uses one mobile command strip and flat essential ledger rows', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/costs?days=30&source=issue-agent&issue=9005');

    const header = page.locator('.console-header[data-current="costs"]');
    const workspace = page.getByRole('region', { name: 'Cost ledger' });
    await expect(header.getByRole('link', { name: 'Costs' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Deck' })).toBeHidden();
    await expect(workspace).toBeVisible();
    await expect(page.getByTestId('ledger-issue-row-compact')).toBeVisible();
    await expect(page.getByTestId('ledger-week-row-compact')).toBeVisible();
    expect((await header.boundingBox())?.height).toBe(64);

    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Deck' })).toBeVisible();
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

    const capture = testInfo.outputPath('costs-mobile.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('costs-mobile.png', {
      path: capture,
      contentType: 'image/png',
    });
  });

  test('keeps the tablet command rail within the viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/costs?days=30');

    const header = page.locator('.console-header[data-current="costs"]');
    await expect(header.getByRole('link', { name: 'Costs' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Deck' })).toBeHidden();
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
