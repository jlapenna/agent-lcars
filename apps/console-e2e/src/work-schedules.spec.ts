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
  test.use({ timezoneId: 'America/Los_Angeles', locale: 'en-US' });

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
      row.getByRole('cell').filter({ hasText: /^no/ }),
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
      row.getByRole('cell').filter({ hasText: /^no/ }),
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
    await expect(row.getByRole('alert')).toContainText(
      'work.operator scope required',
    );
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

  test('edits, confirms deletion, and displays labeled UTC and local occurrences', async ({
    page,
    request,
  }) => {
    const id = '01J5Z3K9QX8F0N2B4V6C8D1E3J';
    const created = await request.put(`/api/work/v1/schedules/${id}`, {
      headers: WORK_ADMIN_HEADERS,
      data: {
        cron: '* * * * *',
        enabled: true,
        spec: {
          title: 'Schedule to edit',
          description: 'Audit scheduling',
          pipeline: 'claude',
          target: { repo: 'supersprinklesracing/sprinkles' },
        },
      },
    });
    expect(created.ok()).toBe(true);
    await page.goto('/work/schedules');
    let row = page.getByRole('row').filter({ hasText: 'Schedule to edit' });
    await expect(row.getByText(/^UTC:/)).toBeVisible();
    const utc = await row.getByText(/^UTC:/).innerText();
    const shownAt = new Date(utc.replace(/^UTC: /u, ''));
    const local = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Los_Angeles',
    }).format(shownAt);
    await expect(
      row.getByText(`Local (America/Los_Angeles): ${local}`, { exact: true }),
    ).toBeVisible();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', {
      name: 'Edit schedule',
      exact: true,
    });
    await expect(
      edit.getByRole('textbox', { name: 'Title', exact: true }),
    ).toHaveValue('Schedule to edit');
    await edit
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Edited schedule');
    await edit.getByRole('textbox', { name: /Cron/ }).fill('15 9 * * *');
    await edit
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(edit).toHaveCount(0);
    row = page.getByRole('row').filter({ hasText: 'Edited schedule' });
    await expect(row).toContainText('15 9 * * *');
    await page.reload();
    await expect(row).toContainText('15 9 * * *');
    const updated = await request.get(`/api/work/v1/schedules/${id}`, {
      headers: WORK_ADMIN_HEADERS,
    });
    expect(await updated.json()).toMatchObject({
      revision: 2,
      cron: '15 9 * * *',
      spec: { title: 'Edited schedule' },
    });
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    let dialog = page.getByRole('dialog', {
      name: 'Delete schedule?',
      exact: true,
    });
    await expect(dialog).toContainText(
      'An already admitted occurrence may still finish.',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(row).toBeVisible();
    expect(
      (
        await request.get(`/api/work/v1/schedules/${id}`, {
          headers: WORK_ADMIN_HEADERS,
        })
      ).ok(),
    ).toBe(true);
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    dialog = page.getByRole('dialog', {
      name: 'Delete schedule?',
      exact: true,
    });
    await dialog
      .getByRole('button', { name: 'Delete schedule', exact: true })
      .click();
    await expect(page.getByText('No schedules yet.')).toBeVisible();
    await page.reload();
    expect(
      (
        await request.get(`/api/work/v1/schedules/${id}`, {
          headers: WORK_ADMIN_HEADERS,
        })
      ).status(),
    ).toBe(404);
  });

  test('retains a stale edit and deletion dialog without claiming success', async ({
    page,
    request,
  }) => {
    const id = '01J5Z3K9QX8F0N2B4V6C8D1E3J';
    const spec = {
      title: 'Concurrent schedule',
      description: 'Preserve operator intent',
      pipeline: 'claude',
      target: { repo: 'supersprinklesracing/sprinkles' },
    };
    expect(
      (
        await request.put(`/api/work/v1/schedules/${id}`, {
          headers: WORK_ADMIN_HEADERS,
          data: { cron: '0 * * * *', spec },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/work/schedules');
    let row = page.getByRole('row').filter({ hasText: 'Concurrent schedule' });
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', {
      name: 'Edit schedule',
      exact: true,
    });
    await edit
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Unsaved edit');
    expect(
      (
        await request.patch(`/api/work/v1/schedules/${id}`, {
          headers: WORK_ADMIN_HEADERS,
          data: {
            expectedRevision: 1,
            cron: '0 * * * *',
            spec: { ...spec, title: 'External change' },
            enabled: true,
          },
        })
      ).ok(),
    ).toBe(true);
    await edit
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(
      edit.getByText('Schedule changed; reload before applying your change'),
    ).toBeVisible();
    await expect(
      edit.getByRole('textbox', { name: 'Title', exact: true }),
    ).toHaveValue('Unsaved edit');
    expect(
      await (
        await request.get(`/api/work/v1/schedules/${id}`, {
          headers: WORK_ADMIN_HEADERS,
        })
      ).json(),
    ).toMatchObject({ revision: 2, spec: { title: 'External change' } });
    await page.reload();
    row = page.getByRole('row').filter({ hasText: 'External change' });
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Delete schedule?',
      exact: true,
    });
    expect(
      (
        await request.post(`/api/work/v1/schedules/${id}/disable`, {
          headers: WORK_ADMIN_HEADERS,
          data: { expectedRevision: 2 },
        })
      ).ok(),
    ).toBe(true);
    await dialog
      .getByRole('button', { name: 'Delete schedule', exact: true })
      .click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Schedule changed; reload before applying your change',
    );
    expect(
      (
        await request.get(`/api/work/v1/schedules/${id}`, {
          headers: WORK_ADMIN_HEADERS,
        })
      ).ok(),
    ).toBe(true);
  });
});
