import { expect, test } from '@playwright/test';

import { E2E_ISSUE_AGENT_SESSION_ID, usePopulatedFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('/sessions workspace @smoke', () => {
  test('uses the compact archive hierarchy on desktop', async ({
    page,
  }, testInfo) => {
    await page.goto('/sessions');

    const header = page.locator('.console-header[data-current="sessions"]');
    const workspace = page.getByRole('region', { name: 'Session archive' });
    await expect(header).toBeVisible();
    await expect(workspace).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Quick task' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(
      workspace.getByRole('navigation', { name: 'Archive view' }),
    ).toBeVisible();
    await expect(workspace.getByRole('table')).toBeVisible();

    expect((await header.boundingBox())?.height).toBeLessThanOrEqual(80);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const capture = testInfo.outputPath('sessions-desktop.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('sessions-desktop.png', {
      path: capture,
      contentType: 'image/png',
    });
  });

  test('switches between flat and by-issue archive views', async ({ page }) => {
    await page.goto('/sessions');

    const workspace = page.getByRole('region', { name: 'Session archive' });
    await workspace.getByRole('link', { name: 'By issue' }).click();
    await expect(page).toHaveURL(/view=by-issue/);
    await expect(page.getByTestId('issue-grouped-sessions')).toBeVisible();

    await workspace.getByRole('link', { name: 'Flat' }).click();
    await expect(page).not.toHaveURL(/view=by-issue/);
    await expect(
      page.getByTestId(`session-row-${E2E_ISSUE_AGENT_SESSION_ID}`),
    ).toBeVisible();
  });

  test('uses one mobile command strip and flat overflow-safe rows', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/sessions');

    const header = page.locator('.console-header[data-current="sessions"]');
    const workspace = page.getByRole('region', { name: 'Session archive' });
    const sessionRow = page.getByTestId(
      `session-card-${E2E_ISSUE_AGENT_SESSION_ID}`,
    );
    await expect(header).toBeVisible();
    await expect(workspace).toBeVisible();
    await expect(header.getByRole('link', { name: 'Sessions' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Queue' })).toBeHidden();
    await expect(page.getByTestId('session-cards')).toBeVisible();
    await expect(sessionRow).toBeVisible();
    expect((await header.boundingBox())?.height).toBe(64);
    await expect(sessionRow).toHaveCSS('border-radius', '0px');

    await page.getByRole('button', { name: 'More console options' }).click();
    await expect(page.getByRole('menuitem', { name: 'Queue' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Agents' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');

    const undersizedControls = await page
      .locator(
        '.console-header[data-current="sessions"] a:visible, .console-header[data-current="sessions"] button:visible, .sessions-workspace a:visible, .sessions-workspace button:visible',
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

    const capture = testInfo.outputPath('sessions-mobile.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('sessions-mobile.png', {
      path: capture,
      contentType: 'image/png',
    });
  });
});
