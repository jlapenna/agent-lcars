import { expect, type Page, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, usePopulatedFixtures } from './seed';
import {
  clearSnoozeFixtures,
  expireSnoozeFixture,
  readSnoozePreferences,
  seedUnrelatedPreference,
} from './util/decision-snooze-seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  E2E_FIXTURE_REPOSITORY,
  updateDashboardAnchor,
} from './util/orchestrator-seed';

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.beforeEach(clearSnoozeFixtures);

test.afterEach(clearSnoozeFixtures);

async function snooze(page: Page, number: number) {
  const row = page.getByTestId(`queue-row-${number}`);
  await row
    .getByRole('button', { name: `More actions for #${number}` })
    .click();
  await page.getByRole('menuitem', { name: 'Snooze', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Snooze decision' })
    .getByRole('button', { name: '15 minutes', exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole('dialog', { name: 'Snooze decision' }),
  ).toHaveCount(0);
}

test('persists per-maintainer snoozes across devices, preserves preferences, and restores on unsnooze or expiry/reload', async ({
  page,
  browser,
  baseURL,
}) => {
  await seedUnrelatedPreference();
  const sameUser = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { 'X-e2e-auth-user': 'e2e-agent-lcars-admin' },
  });
  const otherUser = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { 'X-e2e-auth-user': 'ungranted-admin' },
  });
  try {
    const second = await sameUser.newPage();
    const other = await otherUser.newPage();
    await page.goto('/inbox');
    await snooze(page, E2E_ITEM_NUMBERS.humanNeeded);
    await expect(page.getByText('Snoozed (1)', { exact: true })).toBeVisible();
    await second.goto('/inbox');
    await expect(
      second.getByText('Snoozed (1)', { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toHaveCount(0);
    await other.goto('/inbox');
    await expect(
      other.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toBeVisible();
    await expect(other.getByText('Snoozed (1)', { exact: true })).toHaveCount(
      0,
    );
    expect(await readSnoozePreferences('ungranted-admin')).toBeUndefined();

    await second.getByText('Snoozed (1)', { exact: true }).click();
    await second.getByRole('button', { name: 'Unsnooze', exact: true }).click();
    await expect(
      second.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toBeVisible();
    expect((await readSnoozePreferences())?.['theme']).toBe(
      'keep-this-preference',
    );
    expect((await readSnoozePreferences())?.['decisionSnoozes']).toEqual({});

    await snooze(page, E2E_ITEM_NUMBERS.humanNeeded);
    const anchor = `${E2E_FIXTURE_REPOSITORY}#${E2E_ITEM_NUMBERS.humanNeeded}`;
    const saved = (await readSnoozePreferences())?.['decisionSnoozes'][anchor];
    expect(Date.parse(saved.expiresAt) - Date.parse(saved.snoozedAt)).toBe(
      15 * 60_000,
    );
    await expireSnoozeFixture(anchor);
    await page.reload();
    await second.reload();
    await expect(
      page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toBeVisible();
    await expect(
      second.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toBeVisible();
    await expect(page.getByText('Snoozed (1)', { exact: true })).toHaveCount(0);
  } finally {
    await sameUser.close();
    await otherUser.close();
  }
});

test('keeps concurrent device snoozes and interrupts an old snooze for new human activity', async ({
  page,
  browser,
  baseURL,
}) => {
  const device = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { 'X-e2e-auth-user': 'e2e-agent-lcars-admin' },
  });
  try {
    const second = await device.newPage();
    await Promise.all([page.goto('/inbox'), second.goto('/inbox')]);
    await Promise.all([
      snooze(page, E2E_ITEM_NUMBERS.humanNeeded),
      snooze(second, E2E_ITEM_NUMBERS.readyForAgent),
    ]);
    await page.reload();
    await second.reload();
    await expect(page.getByText('Snoozed (2)', { exact: true })).toBeVisible();
    await expect(
      second.getByText('Snoozed (2)', { exact: true }),
    ).toBeVisible();
    expect(
      Object.keys((await readSnoozePreferences())?.['decisionSnoozes'] ?? {}),
    ).toHaveLength(2);
    await updateDashboardAnchor({
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      sourceUpdatedAt: new Date().toISOString(),
    });
    await page.reload();
    await expect(
      page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toBeVisible();
    await expect(page.getByText('Snoozed (1)', { exact: true })).toBeVisible();
  } finally {
    await device.close();
  }
});

test('an obsolete device cannot unsnooze a replacement decision on the same anchor', async ({
  page,
  browser,
  baseURL,
}) => {
  const device = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { 'X-e2e-auth-user': 'e2e-agent-lcars-admin' },
  });
  try {
    // Keep the first device's observed decision stale, as on a suspended phone.
    await page.clock.install();
    await page.goto('/inbox');
    await snooze(page, E2E_ITEM_NUMBERS.humanNeeded);
    await page.getByText('Snoozed (1)', { exact: true }).click();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const anchor = `${E2E_FIXTURE_REPOSITORY}#${E2E_ITEM_NUMBERS.humanNeeded}`;
    const old = (await readSnoozePreferences())?.['decisionSnoozes'][anchor];
    await updateDashboardAnchor({
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      sourceUpdatedAt: new Date(Date.now() + 2000).toISOString(),
    });
    const second = await device.newPage();
    await second.goto('/inbox');
    await snooze(second, E2E_ITEM_NUMBERS.humanNeeded);
    const replacement = (await readSnoozePreferences())?.['decisionSnoozes'][
      anchor
    ];
    expect(replacement.signature).not.toBe(old.signature);
    await page.getByRole('button', { name: 'Unsnooze', exact: true }).click();
    await expect(page.getByText('Snoozed (1)', { exact: true })).toHaveCount(0);
    expect(
      (await readSnoozePreferences())?.['decisionSnoozes'][anchor],
    ).toEqual(replacement);
    await second.reload();
    await expect(
      second.getByText('Snoozed (1)', { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toHaveCount(0);
  } finally {
    await device.close();
  }
});
