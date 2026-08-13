import { expect, Page, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, usePopulatedFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

const PHONE_VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
] as const;

async function waitForLocalFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready);
}

async function capture(
  page: Page,
  name: string,
  width: number,
  fullPage = false,
) {
  await waitForLocalFonts(page);
  await expect(page).toHaveScreenshot(`${name}-${width}px.png`, { fullPage });
}

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('pinned mobile console baselines @visual', () => {
  for (const viewport of PHONE_VIEWPORTS) {
    test(`protects action hierarchy at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);

      await page.goto('/');
      await expect(page.getByTestId('deck-inbox-summary')).toBeVisible();
      await expect(page.getByTestId('current-work')).toBeVisible();
      await capture(page, 'bridge-initial', viewport.width);

      await page.goto('/inbox');
      const inbox = page.getByRole('region', { name: 'Decision Inbox' });
      await expect(inbox.locator('.queue-workspace__list')).toBeVisible();
      await expect(
        inbox.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`),
      ).toBeVisible();
      await capture(page, 'inbox-list', viewport.width);

      await inbox
        .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`)
        .getByRole('link')
        .click();
      const detail = inbox.locator('.queue-workspace__detail');
      await expect(detail).toBeVisible();
      await detail
        .getByRole('button', {
          name: `More actions for #${E2E_ITEM_NUMBERS.reviewRequested}`,
        })
        .click();
      const itemMenu = page.getByRole('menu');
      await expect(
        itemMenu.getByRole('menuitem', { name: 'Rebase onto base branch' }),
      ).toBeVisible();
      await capture(page, 'inbox-detail-menu', viewport.width);

      await page.goto('/agents');
      const outcomes = page.getByTestId('recent-outcomes');
      await expect(outcomes).toBeVisible();
      await expect(
        outcomes.locator('[data-testid="finished-run-row"]:visible'),
      ).toHaveCount(5);
      await expect(
        outcomes.getByRole('button', { name: /Show \d+ older outcomes/ }),
      ).toBeVisible();
      await capture(page, 'agents-default-collapsed', viewport.width, true);

      await page.goto('/sessions');
      const sessions = page.getByTestId('issue-grouped-sessions');
      await expect(sessions).toBeVisible();
      await expect(
        sessions.locator('[data-testid^="issue-group-"]:visible'),
      ).toHaveCount(5);
      await expect(
        sessions.getByRole('button', {
          name: /Show \d+ older issue groups/,
        }),
      ).toBeVisible();
      await capture(page, 'sessions-default-collapsed', viewport.width, true);
    });
  }
});
