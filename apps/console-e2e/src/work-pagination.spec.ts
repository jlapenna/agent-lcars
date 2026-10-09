import { expect, test } from '@playwright/test';

import { resetCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  E2E_FIXTURE_REPOSITORY,
  seedWorkPagination,
} from './util/orchestrator-seed';

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
    'Pagination fixture 1',
  );
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
    'Pagination fixture 1',
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

test('repository selection and clearing remain reachable on phones across Bridge, Inbox and Agents', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const [route, destination] of [
    ['/', 'Inbox'],
    ['/inbox', 'Agents'],
    ['/agents', 'Bridge'],
  ]) {
    await page.goto(route);
    await page
      .getByLabel('Repository', { exact: true })
      .selectOption(E2E_FIXTURE_REPOSITORY);
    await page
      .getByRole('button', { name: 'Apply repository', exact: true })
      .click();
    await expect(page).toHaveURL(/repo=supersprinklesracing%2Fsprinkles/);
    await expect(page.getByLabel('Repository', { exact: true })).toHaveValue(
      E2E_FIXTURE_REPOSITORY,
    );
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
    await expect(page).toHaveURL(/repo=supersprinklesracing%2Fsprinkles/);
    await expect(page.getByLabel('Repository', { exact: true })).toHaveValue(
      E2E_FIXTURE_REPOSITORY,
    );
    await expect(
      page.getByRole('status', { name: 'Loading', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('link', { name: 'Clear repository', exact: true })
      .click();
    await expect(page).not.toHaveURL(/repo=/);
    await expect(page.getByLabel('Repository', { exact: true })).toHaveValue(
      '',
    );
  }
});
