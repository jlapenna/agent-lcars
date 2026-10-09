import { expect, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, resetCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

const ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const KEY = `work:${ID}`;
const OTHER_KEY = 'work:01J5Z3K9QX8F0N2B4V6C8D1E3H';
const SELECTED = `/inbox?item=${encodeURIComponent(KEY)}`;

useE2eAdminBeforeEach();

test.beforeEach(async ({ request }) => {
  await resetCliSessions();
  const seeded = await request.post('/api/e2e/seed', {
    data: { action: 'seed-inbox' },
  });
  expect(seeded.ok()).toBe(true);
});

test.afterAll(async () => {
  await resetCliSessions();
});

test.describe('native and GitHub human decisions', () => {
  test('joins native parks with one GitHub decision and leaves deploy waits out', async ({
    page,
  }) => {
    await page.goto('/inbox');
    await expect(page.getByTestId(`queue-row-${KEY}`)).toBeVisible();
    await expect(
      page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toHaveCount(1);
    await expect(
      page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.postDeploy}`),
    ).toHaveCount(0);
    await page
      .getByRole('textbox', { name: 'Search the Inbox' })
      .fill('Choose native');
    const row = page.getByTestId(`queue-row-${KEY}`);
    await expect(row).toContainText('supersprinklesracing/sprinkles');
    await expect(row).toContainText(KEY);
    await expect(row.locator('time')).toHaveAttribute('datetime', /T/);
    await expect(row).toContainText(
      'Should native decisions use Firestore or GitHub?',
    );
    await row.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`item=work%3A${ID}`));
    const detail = page.getByTestId('native-decision-detail');
    await expect(
      detail.getByRole('link', { name: 'Full history' }),
    ).toHaveAttribute('href', `/work/${ID}`);
    await expect(
      detail.getByRole('button', { name: 'Reply', exact: true }),
    ).toBeDisabled();
    await expect(
      detail.getByRole('button', { name: /GitHub|Close|Assign|Redispatch/ }),
    ).toHaveCount(0);
    await page.goto('/inbox');
    await expect(page.getByTestId(`queue-row-${OTHER_KEY}`)).toBeVisible();
    await page.goto('/inbox?repo=supersprinklesracing%2Fsprinkles');
    await expect(page.getByTestId(`queue-row-${KEY}`)).toBeVisible();
    await expect(page.getByTestId(`queue-row-${OTHER_KEY}`)).toHaveCount(0);
    await page.goto(
      '/inbox?repo=supersprinklesracing%2Fsprinkles&item=' +
        encodeURIComponent(OTHER_KEY),
    );
    await expect(page.getByTestId('native-decision-detail')).toHaveCount(0);
  });

  test('admits a reply once, reports a fresh session, and removes the answered decision', async ({
    page,
  }) => {
    await page.goto(SELECTED);
    const detail = page.getByTestId('native-decision-detail');
    await detail
      .getByRole('textbox', { name: 'Reply to the agent' })
      .fill('Use Firestore.');
    await detail.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(detail.getByRole('status')).toHaveText(
      /Reply admitted for a fresh session/,
    );
    await expect(page.getByTestId(`queue-row-${KEY}`)).toHaveCount(0);
    await expect(detail.getByRole('textbox')).toHaveCount(0);
    await detail.getByRole('link', { name: 'Full history' }).click();
    await expect(
      page.getByText('Use Firestore.', { exact: true }),
    ).toBeVisible();
  });

  test('reports saved-transcript admission without promising that the runner has resumed', async ({
    page,
    request,
  }) => {
    const seeded = await request.post('/api/e2e/seed', {
      data: { action: 'seed-inbox', resume: true },
    });
    expect(seeded.ok()).toBe(true);
    await page.goto('/inbox');
    await page
      .getByRole('textbox', { name: 'Search the Inbox' })
      .fill('Choose native');
    const detail = page.getByTestId('native-decision-detail');
    await detail
      .getByRole('textbox', { name: 'Reply to the agent' })
      .fill('Use GitHub.');
    await detail.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`item=work%3A${ID}`));
    await expect(detail.getByRole('status')).toHaveText(
      /Resume will be attempted when the agent starts/,
    );
    await expect(page.getByTestId(`queue-row-${KEY}`)).toHaveCount(0);
  });

  test('withholds Reply from an admin without a Work operator grant and rejects direct admission', async ({
    page,
  }) => {
    await page.route('**/*', async (route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          'X-e2e-auth-user': 'ungranted-admin',
        },
      });
    });
    await page.goto(SELECTED);
    const detail = page.getByTestId('native-decision-detail');
    await expect(detail).toContainText(
      'Should native decisions use Firestore or GitHub?',
    );
    await expect(detail).toContainText('Reply requires a Work operator grant');
    await expect(
      detail.getByRole('button', { name: 'Reply', exact: true }),
    ).toHaveCount(0);
    const status = await page.evaluate(async (id) => {
      const response = await fetch(`/api/work/v1/items/${id}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-e2e-auth-user': 'ungranted-admin',
        },
        body: JSON.stringify({ text: 'Try to bypass the grant' }),
      });
      return response.status;
    }, ID);
    expect(status).toBe(401);
  });

  for (const width of [320, 390]) {
    test(`keeps native and GitHub list/detail usable at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/inbox');
      await page.getByTestId(`queue-row-${KEY}`).getByRole('link').click();
      const detail = page.getByTestId('native-decision-detail');
      await expect(
        detail.getByRole('textbox', { name: 'Reply to the agent' }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Back to Inbox list' }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.getByRole('link', { name: 'Back to Inbox list' }).click();
      await expect(page.getByTestId(`queue-row-${KEY}`)).toBeVisible();
      await page
        .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`)
        .getByRole('link')
        .click();
      await expect(page.getByPlaceholder(/Reply/)).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
});
