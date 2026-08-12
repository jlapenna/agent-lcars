import { expect, test } from '@playwright/test';

import { E2E_ISSUE_AGENT_SESSION_ID, usePopulatedFixtures } from './seed';
import {
  expectDesktopBridgeHeader,
  expectMobileBridgeHeader,
} from './util/console-layout';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('/sessions workspace @smoke', () => {
  test('uses the task-grouped archive hierarchy on desktop', async ({
    page,
  }, testInfo) => {
    await page.goto('/sessions');

    const header = page.locator('.console-header[data-current="sessions"]');
    const workspace = page.getByRole('region', { name: 'Session archive' });
    await expectDesktopBridgeHeader(header);
    await expect(workspace).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Quick task' }),
    ).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(
      workspace.getByRole('navigation', { name: 'Archive view' }),
    ).toBeVisible();
    await expect(page.getByTestId('issue-grouped-sessions')).toBeVisible();

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

  test('clips an oversized session title inside the fixed desktop header', async ({
    page,
  }, testInfo) => {
    await page.goto(`/sessions/${E2E_ISSUE_AGENT_SESSION_ID}`);

    const header = page.locator('.console-header[data-current="sessions"]');
    const title = header.locator('.lcars-header-title');

    await expectDesktopBridgeHeader(header);
    await expect(title).toHaveCSS('text-overflow', 'ellipsis');
    await expect(title).toHaveCSS('white-space', 'nowrap');
    expect(
      await title.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);

    const capture = testInfo.outputPath('session-detail-desktop-title.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('session-detail-desktop-title.png', {
      path: capture,
      contentType: 'image/png',
    });
  });

  test('switches between flat and by-issue archive views', async ({ page }) => {
    await page.goto('/sessions');

    const workspace = page.getByRole('region', { name: 'Session archive' });
    await expect(page.getByTestId('issue-grouped-sessions')).toBeVisible();

    await workspace.getByRole('link', { name: 'Flat' }).click();
    await expect(page).toHaveURL(/view=flat/);
    await expect(
      page.getByTestId(`session-row-${E2E_ISSUE_AGENT_SESSION_ID}`),
    ).toBeVisible();

    await workspace.getByRole('link', { name: 'By issue' }).click();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.getByTestId('issue-grouped-sessions')).toBeVisible();
  });

  test('uses one mobile command strip and flat overflow-safe rows', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      '/sessions?days=30&source=issue-agent&issue=9005&view=flat',
    );

    const header = page.locator('.console-header[data-current="sessions"]');
    const workspace = page.getByRole('region', { name: 'Session archive' });
    const sessionRow = page.getByTestId(
      `session-card-${E2E_ISSUE_AGENT_SESSION_ID}`,
    );
    // Wait for the resolved archive body before asserting the header. The
    // outer Suspense fallback intentionally renders a real, shape-matched
    // ConsoleHeader while auth/search params resolve; querying the header
    // first can strict-mode-match both sides of that streamed handoff.
    await expect(workspace).toBeVisible();
    await expect(header).toHaveCount(1);
    await expect(header).toBeVisible();
    await expect(header.getByRole('link', { name: 'Sessions' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Bridge' })).toBeHidden();
    await expect(page.getByTestId('session-cards')).toBeVisible();
    await expect(sessionRow).toBeVisible();
    await expectMobileBridgeHeader(header);
    await expect(sessionRow).toHaveCSS('border-radius', '0px');

    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Bridge' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Agents' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Costs' })).toHaveAttribute(
      'href',
      '/costs?days=30&source=issue-agent&issue=9005',
    );
    await expect(menu.getByRole('button', { name: 'Sign out' })).toBeVisible();
    const menuItems = menu.getByRole('menuitem');
    const undersizedMenuItems = await menuItems.evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect().height)
        .filter((height) => height < 44),
    );
    expect(undersizedMenuItems).toEqual([]);
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

  test('uses the command strip as the only visual mobile header', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/sessions/${E2E_ISSUE_AGENT_SESSION_ID}`);

    const header = page.locator('.console-header[data-current="sessions"]');
    const mobileTitle = page.locator(
      '.console-page-mobile-title[data-current="sessions"]',
    );

    await expectMobileBridgeHeader(header);
    await expect(mobileTitle).toHaveText(
      'E2E fixture: issue-agent session title deliberately exceeds the fixed desktop console header column without overflowing navigation',
    );
    await expect(
      page.getByRole('heading', {
        name: 'E2E fixture: issue-agent session title deliberately exceeds the fixed desktop console header column without overflowing navigation',
      }),
    ).toBeVisible();
    expect(
      await mobileTitle.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          style.display === 'block' &&
          style.position === 'absolute' &&
          style.width === '1px' &&
          style.height === '1px' &&
          style.overflow === 'hidden'
        );
      }),
    ).toBe(true);
    await expect(page.getByTestId('session-header')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const capture = testInfo.outputPath('session-detail-mobile-title.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('session-detail-mobile-title.png', {
      path: capture,
      contentType: 'image/png',
    });
  });

  test('keeps the tablet command rail within the viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/sessions?days=30');

    const header = page.locator('.console-header[data-current="sessions"]');
    await expect(header.getByRole('link', { name: 'Sessions' })).toBeVisible();
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
