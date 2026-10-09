import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, resetCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  NATIVE_WORK_ID,
  readNativeRuns,
  seedDetailNavigationEvidence,
} from './util/native-work';
import { readTaskAdmission } from './util/orchestrator-seed';

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

const journeys = [
  {
    name: 'native',
    path: `/work/${NATIVE_WORK_ID}`,
    issue: undefined,
    question: 'Should native decisions use Firestore or GitHub?',
    verifyReply: async (page: Page) => {
      await expect(page.getByTestId('work-reply-confirmation')).toContainText(
        'Resume will be attempted when the agent starts.',
      );
      const runs = await readNativeRuns();
      expect(
        runs.find((run) => run.runId.endsWith('/r2'))?.params?.[
          'resumeSessionId'
        ],
      ).toBe('e2e-native-resume-session');
    },
  },
  {
    name: 'GitHub',
    path: `/task/supersprinklesracing/sprinkles/${E2E_ITEM_NUMBERS.humanNeeded}`,
    issue: E2E_ITEM_NUMBERS.humanNeeded,
    question: 'Which retention window?',
    verifyReply: async (page: Page) => {
      await expect(
        page.getByRole('status').filter({ hasText: 'Dispatched claude' }),
      ).toBeVisible();
      const admission = await readTaskAdmission(E2E_ITEM_NUMBERS.humanNeeded);
      expect(admission.run?.params).toMatchObject({
        mode: 'reply',
        reply: 'Use thirty days and retain the audit trail.',
        replyChannel: 'console',
        replyPrincipal: 'github:e2e-agent-lcars-admin',
      });
      expect(admission.run?.state).toBe('running');
      await expect(
        page.getByRole('button', { name: 'Redispatch', exact: true }),
      ).toHaveCount(0);
    },
  },
];
for (const journey of journeys) {
  test(`${journey.name} task detail shares parked conversation and navigation on a phone`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const detailPath = journey.path;
    const { ref, sessionId } = await seedDetailNavigationEvidence(
      journey.issue,
    );
    await page.goto(detailPath);
    const history = page.getByTestId('task-detail-history');
    await expect(history).toBeVisible();
    await expect(history.getByTestId('task-detail-provenance')).toContainText(
      'parked',
    );
    await expect(history.getByTestId('agent-turn')).toContainText(
      journey.question,
    );
    for (const heading of [
      'Conversation',
      'Runs',
      'Sessions',
      'Deliverables',
    ]) {
      await expect(
        history.getByRole('heading', { name: heading, exact: true }),
      ).toBeVisible();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      history.getByTestId('task-deliverables').getByRole('link'),
    ).toHaveAttribute('href', ref);
    const session = history.getByRole('link', {
      name: 'Task detail audit session',
    });
    await expect(session).toHaveAttribute('href', `/sessions/${sessionId}`);
    await session.click();
    await expect(page).toHaveURL(`/sessions/${sessionId}`);
    await expect(
      page.getByRole('heading', {
        name: 'Task detail audit session',
        exact: true,
      }),
    ).toBeVisible();
    await page.goto(detailPath);
    await page
      .getByRole('textbox', { name: 'Reply to the agent', exact: true })
      .fill('Use thirty days and retain the audit trail.');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await journey.verifyReply(page);
    await page.reload();
    await expect(
      page
        .getByTestId('task-detail-history')
        .getByText('Use thirty days and retain the audit trail.', {
          exact: true,
        }),
    ).toBeVisible();
    await expect(page.getByTestId('task-detail-provenance')).toContainText(
      'running',
    );
  });
}
