import { expect, type Page, test } from '@playwright/test';

import {
  E2E_ISSUE_AGENT_SESSION_ID,
  E2E_ITEM_NUMBERS,
  usePopulatedFixtures,
} from './seed';
import { setE2eAdminUser } from './util/e2e-test-utils';

const PHONE_VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
] as const;

const AUTHENTICATED_VIEWS = [
  { name: 'Bridge', path: '/', current: 'deck' },
  {
    name: 'selected inbox item',
    path: `/inbox?item=supersprinklesracing%2Fsprinkles%23${E2E_ITEM_NUMBERS.reviewRequested}`,
    current: 'inbox',
  },
  { name: 'Agents', path: '/agents', current: 'agents' },
  { name: 'Shuttlebay', path: '/shuttlebay', current: 'shuttlebay' },
  {
    name: 'sessions by issue',
    path: '/sessions',
    current: 'sessions',
  },
  {
    name: 'sessions flat',
    path: '/sessions?view=flat',
    current: 'sessions',
  },
  {
    name: 'session detail',
    path: `/sessions/${E2E_ISSUE_AGENT_SESSION_ID}`,
    current: 'sessions',
  },
  { name: 'Costs', path: '/costs', current: 'costs' },
  {
    name: 'task detail',
    path: `/task/supersprinklesracing/sprinkles/${E2E_ITEM_NUMBERS.humanNeeded}`,
    current: 'deck',
  },
  { name: 'not found', path: '/not-a-console-route', current: 'deck' },
] as const;

async function expectOneSharedMobileHeader(page: Page, current: string) {
  const header = page.locator(
    `.console-header[data-current="${current}"]:not([data-streaming-fallback])`,
  );
  await expect(header).toHaveCount(1);
  await expect(header).toBeVisible();
  await expect(header.locator('.lcars-header')).toHaveCount(1);
  await expect(header.locator('.lcars-header-title')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(header.locator('.lcars-header-bar')).toHaveCount(1);
  await expect(header.locator('.lcars-command-row')).toHaveCount(1);
  await expect(
    header.locator('nav[aria-label="Console sections"]'),
  ).toHaveCount(1);

  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
}

usePopulatedFixtures();

test.describe('shared mobile header on every console page and view @mobile-layout', () => {
  for (const viewport of PHONE_VIEWPORTS) {
    test(`renders the inherited header everywhere at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      expect(page.viewportSize()).toEqual(viewport);
      await setE2eAdminUser(page);

      for (const view of AUTHENTICATED_VIEWS) {
        await test.step(view.name, async () => {
          await page.goto(view.path);
          await expectOneSharedMobileHeader(page, view.current);
        });
      }
    });

    test(`renders the inherited header on login at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto('/login');
      await expectOneSharedMobileHeader(page, 'deck');
      await expect(
        page.getByRole('button', { name: 'Sign in with GitHub' }),
      ).toBeVisible();
    });
  }
});
