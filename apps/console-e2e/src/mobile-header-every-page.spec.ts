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
const TABLET_VIEWPORT = { width: 768, height: 1024 } as const;
/* 1024px is where the full desktop destination rail first appears. It is also
   an extremely ordinary laptop and iPad-landscape width, and the header
   overflowed it horizontally on five of seven routes for as long as the rail
   used a fixed per-destination width table (#1830). The phone and tablet
   cases above never saw it, and neither did the 1280px default viewport: the
   bug lived in the gap between them. */
const DESKTOP_VIEWPORTS = [
  { width: 768, height: 1024 },
  { width: 1024, height: 800 },
  { width: 1280, height: 900 },
] as const;
/* The console's destinations, in rail order (see CONSOLE_DESTINATIONS in
   console-navigation.ts). Spelled out here the same way
   lcars-interaction-states.spec.ts does rather than imported, so the e2e
   project stays independent of the console's own source. */
const CONSOLE_DESTINATIONS = [
  'Bridge',
  'Inbox',
  'Agents',
  'Shuttlebay',
  'Work',
  'Sessions',
  'Costs',
] as const;

const AUTHENTICATED_VIEWS = [
  { name: 'Bridge', path: '/', current: 'deck' },
  {
    name: 'selected inbox item',
    path: `/inbox?item=supersprinklesracing%2Fsprinkles%23${E2E_ITEM_NUMBERS.humanNeeded}`,
    current: 'inbox',
  },
  { name: 'Agents', path: '/agents', current: 'agents' },
  { name: 'Shuttlebay', path: '/shuttlebay', current: 'shuttlebay' },
  { name: 'Work', path: '/work', current: 'work' },
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

  // Protect the reported overlap in the shared shell on every route. These
  // bounds exercise the browser's actual layout, including nested utilities.
  const geometry = await header.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const arm = parseFloat(
      getComputedStyle(element).getPropertyValue('--lcars-elbow-arm'),
    );
    const controls = Array.from(element.querySelectorAll('a, button'))
      .map((control) => control.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    return {
      outsideFrame: controls.some(
        (box) =>
          box.top < bounds.top + arm + 4 || box.bottom > bounds.bottom - 4,
      ),
      overlapping: controls.some((box, index) =>
        controls
          .slice(index + 1)
          .some(
            (other) =>
              box.left < other.right &&
              box.right > other.left &&
              box.top < other.bottom &&
              box.bottom > other.top,
          ),
      ),
    };
  });
  expect(geometry.outsideFrame).toBe(false);
  expect(geometry.overlapping).toBe(false);
  await expect(page.locator('.console-page-content')).toHaveCSS(
    'padding-top',
    '16px',
  );

  if ((page.viewportSize()?.width ?? 0) >= 768) {
    const alignment = await page.evaluate(() => {
      const content = document.querySelector('.console-page-content');
      const title = document.querySelector(
        '.console-header:not([data-streaming-fallback]) .lcars-header-title',
      );
      if (!content || !title) throw new Error('Shared shell is missing');
      return {
        contentStart:
          content.getBoundingClientRect().left +
          parseFloat(getComputedStyle(content).paddingLeft),
        titleStart: title.getBoundingClientRect().left,
      };
    });
    expect(
      Math.abs(alignment.contentStart - alignment.titleStart),
    ).toBeLessThanOrEqual(1);
  }

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

    test(`keeps the session-detail header controls to one row at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await setE2eAdminUser(page);
      await page.goto(`/sessions/${E2E_ISSUE_AGENT_SESSION_ID}`);

      const header = page.locator(
        '.console-header[data-current="sessions"]:not([data-streaming-fallback])',
      );
      const mobileUtilities = header.locator(
        '.session-detail-utilities--mobile',
      );
      const refreshButton = mobileUtilities.getByRole('button', {
        name: 'Refresh',
      });
      const overflowButton = mobileUtilities.getByRole('button', {
        name: 'More console options',
      });
      await expectOneSharedMobileHeader(page, 'sessions');

      // The session timestamp belongs on the desktop command rail. At a phone
      // width it used to force the refresh and overflow controls into a second
      // row, leaving the shared title bay unusably narrow.
      await expect(mobileUtilities.getByText(/^Updated /)).toBeHidden();
      await expect(refreshButton).toBeVisible();
      await expect(overflowButton).toBeVisible();

      const [refreshBox, overflowBox] = await Promise.all([
        refreshButton.boundingBox(),
        overflowButton.boundingBox(),
      ]);
      expect(refreshBox).not.toBeNull();
      expect(overflowBox).not.toBeNull();
      expect(Math.abs(refreshBox!.y - overflowBox!.y)).toBeLessThanOrEqual(1);
    });

    test(`hides the shared nav header on login at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto('/login');
      await expect(page.locator('.console-header')).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: 'Agent LCARS' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Sign in with GitHub' }),
      ).toBeVisible();

      const widths = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(widths.document).toBeLessThanOrEqual(widths.viewport);
    });
  }

  test('keeps the session-detail header controls to one row at tablet width', async ({
    page,
  }) => {
    await page.setViewportSize(TABLET_VIEWPORT);
    await setE2eAdminUser(page);
    await page.goto(`/sessions/${E2E_ISSUE_AGENT_SESSION_ID}`);

    const header = page.locator(
      '.console-header[data-current="sessions"]:not([data-streaming-fallback])',
    );
    const mobileUtilities = header.locator('.session-detail-utilities--mobile');
    const refreshButton = mobileUtilities.getByRole('button', {
      name: 'Refresh',
    });
    const overflowButton = mobileUtilities.getByRole('button', {
      name: 'More console options',
    });
    await expectOneSharedMobileHeader(page, 'sessions');
    await expect(refreshButton).toBeVisible();
    await expect(overflowButton).toBeVisible();

    const [refreshBox, overflowBox] = await Promise.all([
      refreshButton.boundingBox(),
      overflowButton.boundingBox(),
    ]);
    expect(refreshBox).not.toBeNull();
    expect(overflowBox).not.toBeNull();
    expect(Math.abs(refreshBox!.y - overflowBox!.y)).toBeLessThanOrEqual(1);
  });

  for (const viewport of DESKTOP_VIEWPORTS) {
    for (const view of AUTHENTICATED_VIEWS) {
      test(`fits ${view.name} in a ${viewport.width}px viewport`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await setE2eAdminUser(page);
        await page.goto(view.path);
        await expectOneSharedMobileHeader(page, view.current);

        // Every destination stays reachable on the rail at this width; nothing
        // is dropped from it, and nothing is pushed off the side of the
        // document to make room. `expectOneSharedMobileHeader` above asserts
        // the document width itself.
        const rail = page.locator('nav[aria-label="Console sections"]');
        for (const name of CONSOLE_DESTINATIONS) {
          await expect(
            rail.getByRole('link', { name, exact: true }),
          ).toBeVisible();
        }
      });
    }
  }
});
