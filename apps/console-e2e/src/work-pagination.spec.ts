import type { Frame, Page, Request, Response } from '@playwright/test';
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
  await page
    .getByLabel('Principal', { exact: true })
    .fill('user:pagination-fixture');
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption(E2E_FIXTURE_REPOSITORY);
  await page
    .getByRole('button', { name: 'Apply filters', exact: true })
    .click();
  await expect(page).toHaveURL(/principal=user%3Apagination-fixture/);
  const links = page
    .getByTestId('work-cards')
    .getByRole('link', { name: /^Pagination fixture / });
  await expect(links).toHaveCount(199); // the existing native fixture occupies one raw slot
  const first = await links.allTextContents();
  await page.getByRole('link', { name: 'Next work page' }).click();
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
  await page.getByLabel('State', { exact: true }).selectOption('parked');
  await page
    .getByRole('button', { name: 'Apply filters', exact: true })
    .click();
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(
    page.getByText('No matching work items on this page.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Next work page' }).click();
  await expect(links).toHaveText(['Pagination fixture 1']);
  await expect(page.getByRole('link', { name: 'Next work page' })).toHaveCount(
    0,
  );
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
  await expect(page.getByTestId('bridge-detail-empty')).toBeVisible();
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
    page.getByRole('button', { name: 'Apply filters', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /^Pagination fixture / }),
  ).toHaveCount(0);
});

async function clearRepository(page: Page, destination: string) {
  const pathname = new URL(page.url()).pathname;
  const started = performance.now();
  const phases: { phase: string; elapsedMs: number; status?: number }[] = [];
  const record = (phase: string, status?: number) => {
    if (phases.length < 32) {
      phases.push({
        phase,
        elapsedMs: Math.round(performance.now() - started),
        ...(status === undefined ? {} : { status }),
      });
    }
  };
  // Only this main-frame native GET: no refresh actions, prefetches, headers,
  // bodies or repository query strings in the compact attachment.
  const isClearNavigation = (request: Request) => {
    const url = new URL(request.url());
    return (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      request.method() === 'GET' &&
      url.origin === new URL(page.url()).origin &&
      url.pathname === pathname &&
      !url.searchParams.has('repo')
    );
  };
  const onRequest = (request: Request) => {
    if (isClearNavigation(request)) record('document-request');
  };
  const onResponse = (response: Response) => {
    if (isClearNavigation(response.request()))
      record('document-response', response.status());
  };
  const onFinished = (request: Request) => {
    if (isClearNavigation(request)) record('document-finished');
  };
  const onFailed = (request: Request) => {
    if (isClearNavigation(request)) record('document-failed');
  };
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) record('main-frame-commit');
  };
  const onDomContentLoaded = () => record('dom-content-loaded');
  const onLoad = () => record('load');
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  page.on('framenavigated', onNavigated);
  page.on('domcontentloaded', onDomContentLoaded);
  page.on('load', onLoad);
  try {
    const clear = page.getByRole('link', {
      name: 'Clear repository',
      exact: true,
    });
    await expect(clear).toHaveAttribute('href', pathname);

    await test.step(`Clear repository on ${destination}: click and navigation`, async () => {
      record('click-start');
      // Keep Playwright's real click/actionability and default navigation wait.
      // Both recorded retries finished this action in <100ms. A finite 15s
      // action bound leaves time to attach evidence before the unchanged 90s
      // test deadline, without accepting a missing click or bypassing a wait.
      await clear.click({ timeout: 15_000 });
      record('click-complete');
    });

    await test.step(`Clear repository on ${destination}: resolved route`, async () => {
      await expect(page).toHaveURL(
        (url) => url.pathname === pathname && !url.searchParams.has('repo'),
      );
      record('scope-cleared');
      await expect(
        page.getByRole('combobox', { name: 'Repository', exact: true }),
      ).toHaveValue('');
      await expect(
        page.getByRole('status', { name: 'Loading', exact: true }),
      ).toHaveCount(0);
      record('selector-resolved');
    });
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    page.off('framenavigated', onNavigated);
    page.off('domcontentloaded', onDomContentLoaded);
    page.off('load', onLoad);
    await test
      .info()
      .attach(`repository-clear-${destination.toLowerCase()}-phases`, {
        body: JSON.stringify({
          retry: test.info().retry,
          destination,
          pathname,
          clickTimeoutMs: 15_000,
          phases,
        }),
        contentType: 'application/json',
      });
  }
}

test('repository selection and clearing remain reachable on phones across Bridge, Inbox and Agents', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const [route, destination, destinationPath] of [
    ['/', 'Inbox', '/inbox'],
    ['/inbox', 'Agents', '/agents'],
    ['/agents', 'Bridge', '/'],
  ]) {
    await page.goto(route);
    await page
      .getByRole('combobox', { name: 'Repository', exact: true })
      .selectOption(E2E_FIXTURE_REPOSITORY);
    await page
      .getByRole('button', { name: 'Apply repository', exact: true })
      .click();
    await expect(page).toHaveURL(/repo=supersprinklesracing%2Fsprinkles/);
    await expect(
      page.getByRole('combobox', { name: 'Repository', exact: true }),
    ).toHaveValue(E2E_FIXTURE_REPOSITORY);
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
    await expect(
      page.getByRole('combobox', { name: 'Repository', exact: true }),
    ).toHaveValue(E2E_FIXTURE_REPOSITORY);
    await expect(
      page.getByRole('status', { name: 'Loading', exact: true }),
    ).toHaveCount(0);
    await clearRepository(page, destination);
  }
});
