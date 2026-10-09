import { expect, test } from '@playwright/test';

import { resetCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();

test.beforeEach(async ({ request }) => {
  await resetCliSessions();
  const response = await request.post('/api/e2e/seed', {
    data: { action: 'seed-populated', transcripts: true },
  });
  expect(response.ok()).toBe(true);
});

test.afterAll(async () => {
  await resetCliSessions();
});

test('renders an archived OpenCode detail with bounded turns and safe tool disclosures', async ({
  page,
}) => {
  await page.goto('/sessions/e2e-opencode-full');
  const header = page.getByTestId('session-header');
  await expect(header).toBeVisible();
  await expect(header.getByText('opencode', { exact: true })).toBeVisible();
  const timeline = page.getByTestId('transcript-timeline');
  await expect(timeline.getByText('Audit the OpenCode archive.')).toBeVisible();
  await expect(
    timeline.getByText('Archive review complete.', { exact: false }),
  ).toBeVisible();
  await expect(timeline.getByTestId('transcript-elision')).toContainText(
    'events elided',
  );
  await expect(
    timeline.getByText('Archived turn 449.', { exact: false }),
  ).toContainText('truncated');
  await timeline.getByText('tool: bash', { exact: true }).click();
  await expect(
    timeline.getByText('"command": "inspect archive"', { exact: false }),
  ).toBeVisible();
  await timeline.getByText('tool result', { exact: true }).first().click();
  await expect(
    timeline.getByText('<img src=x onerror=alert(1)> archive checked', {
      exact: true,
    }),
  ).toBeVisible();
  await timeline.getByText('tool result', { exact: true }).nth(1).click();
  await expect(
    timeline.getByText('File not found', { exact: true }),
  ).toBeVisible();
  await expect(
    timeline.locator('script, img, a[href^="javascript:"]'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => 'archiveInjected' in window)).toBe(false);
});

test('distinguishes a valid empty OpenCode archive', async ({ page }) => {
  await page.goto('/sessions/e2e-opencode-empty');
  await expect(page.getByTestId('session-header')).toBeVisible();
  await expect(
    page.getByText('No transcript events.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('transcript-warning')).toHaveCount(0);
});

for (const [id, warning] of [
  ['malformed', 'malformed'],
  ['unavailable', 'unavailable or expired'],
] as const) {
  test(`keeps OpenCode metadata visible for an ${id} archive`, async ({
    page,
  }) => {
    await page.goto(`/sessions/e2e-opencode-${id}`);
    await expect(page.getByTestId('session-header')).toBeVisible();
    await expect(page.getByTestId('transcript-warning')).toContainText(warning);
    await expect(
      page.getByText('No transcript events.', { exact: true }),
    ).toHaveCount(0);
  });
}
