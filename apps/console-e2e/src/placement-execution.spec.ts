import { expect, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, resetCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  NATIVE_WORK_ID,
  NATIVE_WORK_TITLE,
  seedNativeExecutionPhase,
  seedNativePlacementRetry,
} from './util/native-work';

useE2eAdminBeforeEach();

test.beforeEach(async ({ request }) => {
  await resetCliSessions();
  const seeded = await request.post('/api/e2e/seed', {
    data: { action: 'seed-inbox', resume: true },
  });
  expect(seeded.ok()).toBe(true);
});

test.afterAll(async () => {
  await resetCliSessions();
});

test('placement and provider start remain distinct on Agents, Work and canonical history', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedNativeExecutionPhase('waiting-for-placement');
  await page.goto(`/work/${NATIVE_WORK_ID}`);
  const pendingRow = page
    .getByTestId('task-detail-history')
    .getByRole('row')
    .filter({ hasText: `work:${NATIVE_WORK_ID}/r1` });
  await expect(pendingRow).toContainText('Scheduler cannot place this Pod');
  await expect(pendingRow).not.toContainText('Provider process started');
  for (const [phase, label] of [
    ['waiting-for-placement', 'Waiting for placement'],
    ['bootstrapping', 'Bootstrapping'],
    ['provider-execution', 'Provider process started'],
    ['unavailable', 'Placement unavailable'],
    ['stale', 'Placement unavailable'],
  ] as const) {
    const runId = await seedNativeExecutionPhase(phase);
    const githubRunId = await seedNativeExecutionPhase(
      phase,
      E2E_ITEM_NUMBERS.humanNeeded,
    );
    await page.goto(
      `/task/supersprinklesracing/sprinkles/${E2E_ITEM_NUMBERS.humanNeeded}`,
    );
    const taskRow = page
      .getByTestId('task-detail-history')
      .getByRole('row')
      .filter({ hasText: githubRunId });
    await expect(taskRow.getByTestId('execution-status')).toContainText(label);
    await page.goto(`/work/${NATIVE_WORK_ID}`);
    const row = page
      .getByTestId('task-detail-history')
      .getByRole('row')
      .filter({ hasText: runId });
    await expect(row.getByTestId('execution-status')).toContainText(label);
    await page.goto('/work');
    await expect(
      page
        .getByTestId(`work-card-${NATIVE_WORK_ID}`)
        .getByTestId('execution-status'),
    ).toContainText(label);
    await page.goto('/agents');
    const agent = page
      .getByTestId('current-run-row')
      .filter({ hasText: NATIVE_WORK_TITLE });
    await expect(agent.getByTestId('execution-status')).toContainText(label);
    await expect(
      agent.getByRole('link', { name: 'Task/run', exact: true }),
    ).toHaveAttribute(
      'href',
      `/work/${NATIVE_WORK_ID}#run-${encodeURIComponent(runId)}`,
    );
  }
});

test('a settled attempt disappears from execution and its fresh successor starts queued', async ({
  page,
}) => {
  await seedNativeExecutionPhase('provider-execution');
  const successorId = await seedNativePlacementRetry();
  await page.goto(`/work/${NATIVE_WORK_ID}`);
  const history = page.getByTestId('task-detail-history');
  const old = history
    .getByRole('row')
    .filter({ hasText: `work:${NATIVE_WORK_ID}/r1` });
  await expect(old).toContainText('lost');
  await expect(old.getByTestId('execution-status')).toHaveCount(0);
  const successor = history.getByRole('row').filter({ hasText: successorId });
  await expect(successor.getByTestId('execution-status')).toContainText(
    'Queued',
  );
  await expect(successor).not.toContainText('Provider process started');
  await expect(successor).not.toContainText('Placement observed');
});
