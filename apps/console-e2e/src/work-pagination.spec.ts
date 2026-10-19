import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { resetCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  E2E_FIXTURE_REPOSITORY,
  seedWorkPagination,
} from './util/orchestrator-seed';

// Trace is a worker option, so keep this at file scope (as in Inbox actions).
// The original clear-link stalls lost their first-attempt trace (#2239).
test.use({ trace: 'retain-on-failure' });

useE2eAdminBeforeEach();

test.beforeEach(async ({ request }) => {
  await resetCliSessions();
  expect(
    (
      await request.post('/api/e2e/seed', {
        data: { action: 'seed-inbox-only' },
      })
    ).ok(),
  ).toBe(true);
});

test.afterAll(async () => {
  await resetCliSessions();
});

test('Work filters and cursors reach 205 items and an older park at 320px', async ({
  page,
}) => {
  await seedWorkPagination();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/work');
  // The subtitle's schedules link is hidden on phones; the band keeps one.
  await expect(
    page.getByRole('link', { name: 'Schedules →', exact: true }),
  ).toBeVisible();
  // Toolbar selects submit on change and carry the typed principal with them;
  // principal sits behind More filters so the band stays one row.
  // Phones fold the selects and More filters behind the Filters toggle.
  await openToolbarFilters(page);
  const moreFilters = page.locator('summary', { hasText: /^More filters/ });
  await moreFilters.click();
  await page
    .getByLabel('Principal', { exact: true })
    .fill('user:pagination-fixture');
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption(E2E_FIXTURE_REPOSITORY);
  await expect(page).toHaveURL(/principal=user%3Apagination-fixture/);
  const links = page
    .getByTestId('work-cards')
    .getByRole('link', { name: /^Pagination fixture / });
  await expect(links).toHaveCount(199); // the existing native fixture occupies one raw slot
  // A full screenful of matches stops the scan at the first store page.
  await expect(page.getByTestId('work-scan-extent')).toHaveText(
    'Searched up to 200 native tasks; older work continues on the next page.',
  );
  const first = await links.allTextContents();
  await page.getByRole('link', { name: 'Search older work' }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page).toHaveURL(/repo=supersprinklesracing%2Fsprinkles/);
  await expect(page.getByLabel('Principal', { exact: true })).toHaveValue(
    'user:pagination-fixture',
  );
  await expect(
    page.getByRole('status', { name: 'Loading', exact: true }),
  ).toHaveCount(0);
  await expect(links).toHaveCount(6);
  const second = await links.allTextContents();
  expect(new Set([...first, ...second]).size).toBe(205);
  expect([...first, ...second].sort()).toEqual(
    Array.from({ length: 205 }, (_, i) => `Pagination fixture ${i + 1}`).sort(),
  );
  await page.reload();
  await expect(links).toHaveCount(6);
  await openToolbarFilters(page);
  await moreFilters.click();
  await page.getByLabel('State', { exact: true }).selectOption('parked');
  await expect(page).not.toHaveURL(/cursor=/);
  // The newest store page holds no parked fixture; the view reads on to the
  // older page that does instead of showing an empty page (#1546).
  await expect(links).toHaveText(['Pagination fixture 1']);
  await expect(page.getByTestId('work-scan-extent')).toHaveText(
    'Searched 2 pages of up to 200 native tasks, through the oldest.',
  );
  await expect(
    page.getByRole('link', { name: 'Search older work' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto('/work?cursor=invalid');
  await expect(
    page
      .getByRole('region', { name: 'Work items', exact: true })
      .getByRole('alert'),
  ).toContainText('Invalid Work filters or cursor');
  await page.getByRole('link', { name: 'Reset filters', exact: true }).click();
  await expect(page.getByLabel('State', { exact: true })).toHaveValue('');

  await page.goto(`/?repo=${encodeURIComponent(E2E_FIXTURE_REPOSITORY)}`);
  await expect(page.getByTestId('parked-work-panel')).not.toContainText(
    'Pagination fixture 1',
  );
  await page.getByRole('link', { name: 'Older stopped work' }).click();
  await expect(page).toHaveURL(/stoppedCursor=/);
  await expect(page.getByTestId('parked-work-panel')).toContainText(
    'Pagination fixture 1',
  );
  await page.reload();
  await expect(page.getByTestId('parked-work-panel')).toContainText(
    'Pagination fixture 1',
  );
  const stoppedPageUrl = page.url();
  const stoppedCursor = new URL(stoppedPageUrl).searchParams.get(
    'stoppedCursor',
  );
  const olderRow = page
    .getByTestId('parked-work-panel')
    .getByRole('link', { name: 'Pagination fixture 1', exact: true });
  // Phones retain the canonical full-detail link; desktop selects the pane.
  await expect(olderRow).toHaveAttribute(
    'href',
    '/work/00000000000000000000000001',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(olderRow).toHaveAttribute('href', /sel=parked/);
  await olderRow.click();
  await expect(page.getByTestId('bridge-detail')).toContainText(
    'work:00000000000000000000000001/r1',
  );
  await expect(
    page
      .getByTestId('bridge-detail')
      .getByRole('link', { name: 'View full history ↗', exact: true }),
  ).toHaveAttribute('href', '/work/00000000000000000000000001');
  const selectedUrl = page.url();
  expect(new URL(selectedUrl).searchParams.get('stoppedCursor')).toBe(
    stoppedCursor,
  );
  expect(new URL(selectedUrl).searchParams.get('repo')).toBe(
    E2E_FIXTURE_REPOSITORY,
  );
  await page.getByRole('link', { name: '← All activity', exact: true }).click();
  await expect(page).toHaveURL(stoppedPageUrl);
  await expect(olderRow).toBeVisible();
  // With nothing selected the Bridge renders no detail pane at all.
  await expect(page.getByTestId('bridge-detail')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(selectedUrl);
  await expect(page.getByTestId('bridge-detail')).toContainText(
    'work:00000000000000000000000001/r1',
  );
  await page.goForward();
  await expect(page).toHaveURL(stoppedPageUrl);
  await page.reload();
  await expect(olderRow).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/?stoppedCursor=invalid');
  await expect(
    page.getByTestId('parked-work-panel').getByRole('alert'),
  ).toContainText('Could not load stopped work');
  await page
    .getByRole('link', { name: 'Reset stopped-work page', exact: true })
    .click();
  await expect(page).not.toHaveURL(/stoppedCursor=/);
  await page.route('**/*', (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        'X-e2e-auth-user': 'ungranted-admin',
      },
    }),
  );
  await page.goto('/work?principal=user%3Apagination-fixture');
  await expect(
    page.getByText('Your GitHub login has no work grant.'),
  ).toBeVisible();
  await expect(
    page.getByRole('search', { name: 'Filters', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /^Pagination fixture / }),
  ).toHaveCount(0);
});

/** The Inbox's repository select is in its toolbar band, which streams in
 * with the decision queue; wait for it rather than sampling once. */
async function revealInboxRepositoryFilter(page: Page) {
  if (new URL(page.url()).pathname !== '/inbox') return;
  // Phones fold the Inbox's selects behind its Filters toggle; the selects
  // act only once hydrated.
  const toolbar = page.locator('.inbox-toolbar').filter({ visible: true });
  await expect(toolbar).toHaveAttribute('data-hydrated', '');
  await openFold(toolbar);
  await expect(
    page.getByRole('combobox', { name: 'Repository', exact: true }),
  ).toBeVisible();
}

async function clearRepository(
  page: Page,
  destination: string,
  expectClearedControls: (page: Page) => Promise<void>,
) {
  const pathname = new URL(page.url()).pathname;
  const clear = page.getByRole('link', {
    name: 'Clear repository',
    exact: true,
  });
  await expect(clear).toHaveAttribute('href', pathname);

  await test.step(`Clear repository on ${destination}: click and navigation`, async () => {
    // Keep Playwright's real click/actionability and default navigation wait.
    // A finite 15s action bound fails fast inside the unchanged 90s test
    // deadline, without accepting a missing click or bypassing a wait.
    await clear.click({ timeout: 15_000 });
  });

  await test.step(`Clear repository on ${destination}: resolved route`, async () => {
    await expect(page).toHaveURL(
      (url) => url.pathname === pathname && !url.searchParams.has('repo'),
    );
    await revealInboxRepositoryFilter(page);
    await expectClearedControls(page);
    await expect(
      page.getByRole('status', { name: 'Loading', exact: true }),
    ).toHaveCount(0);
  });
}

async function expectNoBridgeRepositoryForm(page: Page) {
  await expect(
    page.getByRole('combobox', { name: 'Repository', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Apply repository', exact: true }),
  ).toHaveCount(0);
}

async function expectSelectedRepositoryForm(page: Page) {
  await openToolbarFilters(page);
  await expect(
    page.getByRole('combobox', { name: 'Repository', exact: true }),
  ).toHaveValue(E2E_FIXTURE_REPOSITORY);
}

async function expectClearedRepositoryForm(page: Page) {
  await openToolbarFilters(page);
  await expect(
    page.getByRole('combobox', { name: 'Repository', exact: true }),
  ).toHaveValue('');
}

async function selectBridgeRepositoryLink(page: Page) {
  await expectNoBridgeRepositoryForm(page);
  await page.goto(`/?${new URLSearchParams({ repo: E2E_FIXTURE_REPOSITORY })}`);
}

/** Phones fold a workspace toolbar's selects behind its Filters toggle. */
async function openToolbarFilters(page: Page) {
  // The Inbox draws its own toolbar; revealInboxRepositoryFilter opens its
  // fold.
  if (new URL(page.url()).pathname === '/inbox') return;
  // Wait for the toolbar to stream in and hydrate: its selects submit on
  // change from then. Checking for the form before it arrives would skip the
  // toggle and leave the select folded.
  const form = page.getByRole('search', { name: 'Filters' });
  await expect(form).toHaveAttribute('data-hydrated', '');
  await openFold(form);
}

/** Opens a phone toolbar's fold. Its checkbox is drawn by its label, which
 * takes the tap; desktops draw no toggle and fold nothing. */
async function openFold(toolbar: Locator) {
  const toggle = toolbar.locator('label.console-toolbar__toggle');
  if (
    (await toggle.isVisible()) &&
    !(await toggle.getByRole('checkbox').isChecked())
  ) {
    await toggle.click();
    await expect(toggle.getByRole('checkbox')).toBeChecked();
  }
}

async function selectRepositoryForm(page: Page) {
  await revealInboxRepositoryFilter(page);
  await openToolbarFilters(page);
  await page
    .getByRole('combobox', { name: 'Repository', exact: true })
    .selectOption(E2E_FIXTURE_REPOSITORY);
  await revealInboxRepositoryFilter(page);
  await expectSelectedRepositoryForm(page);
}

test('repository selection and clearing remain reachable on phones across Bridge, Inbox and Agents', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const journey of [
    {
      route: '/',
      destination: 'Inbox',
      destinationPath: '/inbox',
      select: selectBridgeRepositoryLink,
      expectSelected: expectSelectedRepositoryForm,
      expectCleared: expectClearedRepositoryForm,
    },
    {
      route: '/inbox',
      destination: 'Agents',
      destinationPath: '/agents',
      select: selectRepositoryForm,
      expectSelected: expectSelectedRepositoryForm,
      expectCleared: expectClearedRepositoryForm,
    },
    {
      route: '/agents',
      destination: 'Bridge',
      destinationPath: '/',
      select: selectRepositoryForm,
      expectSelected: expectNoBridgeRepositoryForm,
      expectCleared: expectNoBridgeRepositoryForm,
    },
  ]) {
    const { route, destination, destinationPath } = journey;
    await page.goto(route);
    await journey.select(page);
    await expect(page).toHaveURL(/repo=supersprinklesracing%2Fsprinkles/);
    await expect(
      page.getByRole('link', { name: 'Clear repository', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // The phone utility menu must carry scope to the next destination.
    await page
      .getByRole('button', { name: 'More console options', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: destination, exact: true })
      .click();
    // The source URL already has this repository. Wait for the destination,
    // then query its accessible control: Cache Components keeps the previous
    // route's selector in a hidden Activity subtree (#503, #2239).
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === destinationPath &&
        url.searchParams.get('repo') === E2E_FIXTURE_REPOSITORY,
    );
    await revealInboxRepositoryFilter(page);
    await journey.expectSelected(page);
    await expect(
      page.getByRole('status', { name: 'Loading', exact: true }),
    ).toHaveCount(0);
    await clearRepository(page, destination, journey.expectCleared);
  }
});
