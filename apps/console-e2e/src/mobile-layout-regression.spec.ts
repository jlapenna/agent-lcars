import { expect, type Locator, type Page, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, usePopulatedFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

const PHONE_VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
}

async function expectWithinViewport(page: Page, locator: Locator) {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!bounds || !viewport) return;

  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
}

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('mobile console layout contracts @mobile-layout', () => {
  for (const viewport of PHONE_VIEWPORTS) {
    test(`keeps the action hierarchy usable at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);

      await page.goto('/');
      const inboxSummary = page.getByTestId('deck-inbox-summary');
      const currentWork = page.getByTestId('current-work');
      await expect(inboxSummary).toBeVisible();
      await expect(currentWork).toBeVisible();
      const [inboxBounds, workBounds] = await Promise.all([
        inboxSummary.boundingBox(),
        currentWork.boundingBox(),
      ]);
      expect(inboxBounds?.y).toBeLessThan(workBounds?.y ?? 0);
      await expectNoHorizontalOverflow(page);

      await page.goto('/inbox');
      const inbox = page.getByRole('region', { name: 'Decision Inbox' });
      const reviewRow = inbox.getByTestId(
        `queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`,
      );
      await expect(inbox.locator('.queue-workspace__list')).toBeVisible();
      await expect(reviewRow).toBeVisible();
      await expectWithinViewport(page, reviewRow);
      await expectNoHorizontalOverflow(page);

      await reviewRow.getByRole('link').click();
      const detail = inbox.locator('.queue-workspace__detail');
      await expect(detail).toBeVisible();
      await detail
        .getByRole('button', {
          name: `More actions for #${E2E_ITEM_NUMBERS.humanNeeded}`,
        })
        .click();
      const itemMenu = page.getByRole('menu');
      await expect(itemMenu).toBeVisible();
      await expect(
        itemMenu.getByRole('menuitem', { name: 'Approve & Rebase' }),
      ).toBeVisible();
      await expect(
        itemMenu.getByRole('menuitem', { name: 'Mute' }),
      ).toBeVisible();
      await expectWithinViewport(page, itemMenu);
      await expectNoHorizontalOverflow(page);

      await page.goto('/agents');
      const outcomes = page.getByTestId('recent-outcomes');
      await expect(outcomes).toBeVisible();
      await expect(
        outcomes.locator('[data-testid="finished-run-row"]:visible'),
      ).toHaveCount(5);
      const olderOutcomes = outcomes.getByRole('button', {
        name: /Show \d+ older outcomes/,
      });
      await expect(olderOutcomes).toBeVisible();
      await expectWithinViewport(page, olderOutcomes);
      await expectNoHorizontalOverflow(page);

      await page.goto('/sessions');
      const sessions = page.getByTestId('issue-grouped-sessions');
      await expect(sessions).toBeVisible();
      await expect(
        sessions.locator('[data-testid^="issue-group-"]:visible'),
      ).toHaveCount(5);
      const olderSessions = sessions.getByRole('button', {
        name: /Show \d+ older issue groups/,
      });
      await expect(olderSessions).toBeVisible();
      await expectWithinViewport(page, olderSessions);
      await expectNoHorizontalOverflow(page);
    });
  }
});
