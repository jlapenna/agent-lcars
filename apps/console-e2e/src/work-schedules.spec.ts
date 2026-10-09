import { expect, test } from '@playwright/test';

import { resetCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  NATIVE_WORK_ID,
  NATIVE_WORK_TITLE,
  resetSchedules,
  seedLastScheduleItem,
  WORK_ADMIN_HEADERS,
} from './util/native-work';

useE2eAdminBeforeEach();

test.beforeEach(async ({ request }) => {
  await resetCliSessions();
  await resetSchedules();
  const seeded = await request.post('/api/e2e/seed', {
    data: { action: 'seed-inbox-only' },
  });
  expect(seeded.ok()).toBe(true);
});

test.afterAll(async () => {
  await resetSchedules();
  await resetCliSessions();
});

test.describe('Work schedule mutation journeys', () => {
  test('creates, enables, disables and follows Last item after reload', async ({
    page,
    request,
  }) => {
    await page.goto('/work/schedules');
    await expect(page.getByText('No schedules yet.')).toBeVisible();
    const form = page.getByRole('form', { name: 'Create schedule' });
    await form
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Daily native audit');
    await form
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Audit native Work decisions daily.');
    await form.getByRole('textbox', { name: /Cron/ }).fill('15 9 * * *');
    await form.getByRole('switch', { name: 'Enabled', exact: true }).uncheck();
    await form
      .getByRole('button', { name: 'Create schedule', exact: true })
      .click();
    await expect(
      form.getByRole('textbox', { name: 'Title', exact: true }),
    ).toHaveValue('');
    await page.reload();
    const row = page.getByRole('row').filter({ hasText: 'Daily native audit' });
    await expect(row).toContainText('15 9 * * *');
    await expect(row).toContainText('supersprinklesracing/sprinkles');
    await expect(
      row.getByRole('cell', { name: 'no', exact: true }),
    ).toBeVisible();
    await expect(
      row.getByRole('cell', { name: 'never', exact: true }),
    ).toBeVisible();
    await row.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(
      row.getByRole('cell', { name: 'yes', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      row.getByRole('button', { name: 'Disable', exact: true }),
    ).toBeVisible();
    await row.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(
      row.getByRole('cell', { name: 'no', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      row.getByRole('button', { name: 'Enable', exact: true }),
    ).toBeVisible();
    const response = await request.get('/api/work/v1/schedules', {
      headers: WORK_ADMIN_HEADERS,
    });
    expect(response.ok()).toBe(true);
    const { schedules } = await response.json();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      enabled: false,
      disabledReason: 'operator',
      createdBy: 'user:e2e-agent-lcars-admin',
      spec: {
        title: 'Daily native audit',
        description: 'Audit native Work decisions daily.',
      },
    });
    await seedLastScheduleItem(schedules[0].id);
    await page.reload();
    await row.getByRole('link', { name: NATIVE_WORK_ID, exact: true }).click();
    await expect(page).toHaveURL(`/work/${NATIVE_WORK_ID}`);
    await expect(
      page.getByRole('heading', { name: NATIVE_WORK_TITLE, exact: true }),
    ).toBeVisible();
  });

  test('keeps rejected schedule input and never displays a phantom schedule', async ({
    page,
    request,
  }) => {
    await page.goto('/work/schedules');
    const form = page.getByRole('form', { name: 'Create schedule' });
    await form
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Rejected schedule');
    await form
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Do not persist this request.');
    // Valid syntax, but impossible date: reaches the server's rejection path.
    await form.getByRole('textbox', { name: /Cron/ }).fill('0 0 31 2 *');
    await form
      .getByRole('button', { name: 'Create schedule', exact: true })
      .click();
    await expect(
      form.getByText('cron expression never fires within a year'),
    ).toBeVisible();
    await expect(
      form.getByRole('textbox', { name: 'Title', exact: true }),
    ).toHaveValue('Rejected schedule');
    await expect(
      page.getByRole('row').filter({ hasText: 'Rejected schedule' }),
    ).toHaveCount(0);
    await form.getByRole('textbox', { name: /Cron/ }).fill('0 * * * *');
    await form
      .getByRole('textbox', { name: 'Repository', exact: true })
      .fill('unwatched/repository');
    await form
      .getByRole('button', { name: 'Create schedule', exact: true })
      .click();
    await expect(
      form.getByText('no grant for that pipeline or repository'),
    ).toBeVisible();
    await expect(
      form.getByRole('textbox', { name: 'Repository', exact: true }),
    ).toHaveValue('unwatched/repository');
    await page.reload();
    await expect(page.getByText('No schedules yet.')).toBeVisible();
    const response = await request.get('/api/work/v1/schedules', {
      headers: WORK_ADMIN_HEADERS,
    });
    expect(response.ok()).toBe(true);
    expect((await response.json()).schedules).toHaveLength(0);
  });

  test('rejects unauthorized toggling and preserves the displayed and durable enabled state', async ({
    page,
    request,
  }) => {
    // Setup through the normal API; the denied toggle uses its real Server Action.
    const created = await request.put(
      '/api/work/v1/schedules/01J5Z3K9QX8F0N2B4V6C8D1E3J',
      {
        headers: WORK_ADMIN_HEADERS,
        data: {
          id: '01J5Z3K9QX8F0N2B4V6C8D1E3J',
          cron: '0 * * * *',
          enabled: true,
          spec: {
            title: 'Protected schedule',
            description: 'Keep this enabled.',
            pipeline: 'claude',
            target: { repo: 'supersprinklesracing/sprinkles' },
          },
        },
      },
    );
    expect(created.ok()).toBe(true);
    await page.goto('/work/schedules');
    const row = page.getByRole('row').filter({ hasText: 'Protected schedule' });
    await expect(
      row.getByRole('cell', { name: 'yes', exact: true }),
    ).toBeVisible();
    await page.route('**/*', async (route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          'X-e2e-auth-user': 'ungranted-admin',
        },
      });
    });
    await row.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(
      page.getByText('work.operator scope required', { exact: true }),
    ).toBeVisible();
    await expect(
      row.getByRole('cell', { name: 'yes', exact: true }),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Disable', exact: true }),
    ).toBeEnabled();
    await expect(
      row.getByRole('button', { name: 'Enable', exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByText('Your GitHub login has no work grant.'),
    ).toBeVisible();
    await expect(
      page.getByRole('form', { name: 'Create schedule' }),
    ).toHaveCount(0);
    await page.unrouteAll();
    await page.route('**/*', (route) =>
      route.continue({
        headers: { ...route.request().headers(), ...WORK_ADMIN_HEADERS },
      }),
    );
    await page.reload();
    await expect(
      row.getByRole('cell', { name: 'yes', exact: true }),
    ).toBeVisible();
  });
});
