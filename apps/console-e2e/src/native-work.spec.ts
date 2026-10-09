import { expect, test } from '@playwright/test';

import { resetCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  NATIVE_WORK_ID as ID,
  NATIVE_WORK_TITLE as TITLE,
  readNativeRuns,
  WORK_ADMIN_HEADERS,
} from './util/native-work';

const DETAIL = `/work/${ID}`;
const API = `/api/work/v1/items/${ID}`;

useE2eAdminBeforeEach();

test.beforeEach(async ({ request }) => {
  await resetCliSessions();
  const response = await request.post('/api/e2e/seed', {
    data: { action: 'seed-inbox-only' },
  });
  expect(response.ok()).toBe(true);
});

test.afterAll(async () => {
  await resetCliSessions();
});

test.describe('native Work mutation journeys', () => {
  test('opens populated listing and saves title and description durably', async ({
    page,
  }) => {
    await page.goto('/work');
    const row = page.getByRole('row').filter({ hasText: TITLE });
    await expect(row).toContainText('parked');
    await expect(row).toContainText('supersprinklesracing/sprinkles');
    await row.getByRole('link', { name: TITLE, exact: true }).click();
    await expect(page).toHaveURL(DETAIL);
    await expect(
      page.getByText('Implement durable storage.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('agent-turn')).toContainText(
      'Should native decisions use Firestore or GitHub?',
    );
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('');
    await expect(save).toBeDisabled();
    await page
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Persist native decisions');
    await page
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Store the decision and its audit trail in Firestore.');
    await save.click();
    await expect(
      page.getByRole('heading', {
        name: 'Persist native decisions',
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', {
        name: 'Persist native decisions',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Store the decision and its audit trail in Firestore.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.goto('/work');
    await expect(
      page.getByRole('row').filter({ hasText: 'Persist native decisions' }),
    ).toContainText('parked');
  });

  for (const resume of [false, true]) {
    test(`reply persists a new conversation round with ${resume ? 'resume binding' : 'fresh fallback'}`, async ({
      page,
      request,
    }) => {
      const response = await request.post('/api/e2e/seed', {
        data: { action: 'seed-inbox-only', resume },
      });
      expect(response.ok()).toBe(true);
      await page.goto(DETAIL);
      const reply = page.getByRole('button', { name: 'Reply', exact: true });
      await expect(reply).toBeDisabled();
      await page
        .getByPlaceholder('Reply to the agent...')
        .fill('Use Firestore and retain the audit trail.');
      await reply.click();
      await expect(page.getByText('running', { exact: true })).toBeVisible();
      await page.reload();
      await expect(
        page.getByText('Use Firestore and retain the audit trail.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('row').filter({ hasText: `work:${ID}/r2` }),
      ).toContainText('pending');
      await expect(
        page.getByRole('button', { name: 'Reply', exact: true }),
      ).toHaveCount(0);
      const runs = await readNativeRuns();
      expect(runs).toHaveLength(2);
      const admitted = runs.find((run) => run.runId === `work:${ID}/r2`);
      expect(admitted?.params).toMatchObject({
        mode: 'reply',
        reply: 'Use Firestore and retain the audit trail.',
        replyChannel: 'console',
        replyPrincipal: 'user:e2e-agent-lcars-admin',
      });
      expect(admitted?.params?.['resumeSessionId']).toBe(
        resume ? 'e2e-native-resume-session' : undefined,
      );
      expect(admitted?.params?.['resumeTranscriptGcsUri']).toBe(
        resume
          ? 'gs://demo-no-project/e2e-native-resume-session.jsonl'
          : undefined,
      );
    });
  }

  test('redispatches once, disables actions in flight, then cancels the queued run durably', async ({
    page,
  }) => {
    await page.goto(DETAIL);
    // Hold the real Server Action request at the browser boundary. Let it
    // reach the server after checking pending controls; never fake a result.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/work/*', async (route) => {
      if (route.request().headers()['next-action']) await held;
      await route.fallback();
    });
    await page.getByRole('button', { name: 'Redispatch', exact: true }).click();
    try {
      await expect(
        page.getByRole('button', { name: 'Redispatch', exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Reply', exact: true }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await expect(page.getByText('running', { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('row').filter({ hasText: `work:${ID}/r2` }),
    ).toContainText('pending');
    await expect(
      page.getByRole('button', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      page.getByText('canceled', { exact: true }).first(),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('row').filter({ hasText: `work:${ID}/r2` }),
    ).toContainText('canceled');
    await expect(
      page.getByRole('button', { name: 'Cancel', exact: true }),
    ).toHaveCount(0);
    await page.goto('/work');
    await expect(
      page.getByRole('row').filter({ hasText: TITLE }),
    ).toContainText('canceled');
    expect(await readNativeRuns()).toHaveLength(2);
  });

  test('keeps a refused edit and reply when a concurrent operator admits work', async ({
    page,
    request,
  }) => {
    await page.goto(DETAIL);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Refused title');
    await page
      .getByPlaceholder('Reply to the agent...')
      .fill('Keep this refused reply.');
    const admitted = await request.post(`${API}/reply`, {
      headers: WORK_ADMIN_HEADERS,
      data: { text: 'Other operator reply' },
    });
    expect(admitted.ok()).toBe(true);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByText('task-busy', { exact: true }).last(),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Title', exact: true }),
    ).toHaveValue('Refused title');
    await expect(
      page.getByRole('heading', { name: TITLE, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.getByPlaceholder('Reply to the agent...')).toHaveValue(
      'Keep this refused reply.',
    );
    await page.reload();
    await expect(
      page.getByRole('heading', { name: TITLE, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Other operator reply', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Keep this refused reply.', { exact: true }),
    ).toHaveCount(0);
    expect(await readNativeRuns()).toHaveLength(2);
  });

  test('rejects stale redispatch after another operator cancels', async ({
    page,
    request,
  }) => {
    await page.goto(DETAIL);
    await expect(
      page.getByRole('button', { name: 'Redispatch', exact: true }),
    ).toBeVisible();
    const canceled = await request.post(`${API}/cancel`, {
      headers: WORK_ADMIN_HEADERS,
    });
    expect(canceled.ok()).toBe(true);
    await page.getByRole('button', { name: 'Redispatch', exact: true }).click();
    await expect(
      page.getByText('only a parked or failed item can be redispatched'),
    ).toBeVisible();
    await expect(page.getByText('parked', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('canceled', { exact: true })).toBeVisible();
    expect(await readNativeRuns()).toHaveLength(1);
  });

  test('rejects a Server Action after operator authority is lost without changing the item', async ({
    page,
  }) => {
    await page.goto(DETAIL);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Unauthorized edit');
    await page.route('**/*', async (route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          'X-e2e-auth-user': 'ungranted-admin',
        },
      });
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByText('work.operator scope required', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: TITLE, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Title', exact: true }),
    ).toHaveValue('Unauthorized edit');
    await page.reload();
    await expect(
      page.getByText('Your GitHub login has no work grant.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    await page.unrouteAll();
    await page.route('**/*', (route) =>
      route.continue({
        headers: { ...route.request().headers(), ...WORK_ADMIN_HEADERS },
      }),
    );
    await page.reload();
    await expect(
      page.getByRole('heading', { name: TITLE, exact: true }),
    ).toBeVisible();
    await expect(page.getByText('parked', { exact: true })).toBeVisible();
  });
});
