import { expect, test } from '@playwright/test';

import {
  E2E_CLI_SESSION_IDS,
  E2E_FIXTURE_PR_NUMBER,
  resetCliSessions,
  seedCliSessions,
} from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();

test.beforeEach(async () => {
  await resetCliSessions();
  await seedCliSessions();
});

test.afterAll(async () => {
  await resetCliSessions();
});

// @smoke: this is the only spec in the suite so far — it must run in the
// default per-PR smoke lane (E2E_GREP=@smoke, #2599), not just the
// run-e2e-labeled full tier.
test.describe('Agent Activity panel CLI sessions @smoke', () => {
  test('renders active sessions inline and finished ones behind the collapsed disclosure', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByText('CLI sessions', { exact: true })).toBeVisible();

    const liveRow = page.getByTestId(`cli-session-${E2E_CLI_SESSION_IDS.live}`);
    await expect(liveRow.getByTestId('cli-session-liveness')).toHaveText(
      'live',
    );
    await expect(liveRow).toContainText('e2e-fixture-host-1');
    await expect(liveRow).toContainText('e2e-agent-console-fixture-branch');
    await expect(liveRow).toContainText('agent-console-e2e-fixture');
    await expect(liveRow).toContainText('claude-sonnet-5');
    await expect(liveRow).toContainText('12 turns');
    await expect(liveRow).toContainText('12.2k tokens');
    await expect(
      liveRow.getByRole('link', { name: `PR #${E2E_FIXTURE_PR_NUMBER} ↗` }),
    ).toBeVisible();

    const idleRow = page.getByTestId(`cli-session-${E2E_CLI_SESSION_IDS.idle}`);
    await expect(idleRow.getByTestId('cli-session-liveness')).toHaveText(
      'idle',
    );
    await expect(idleRow).toContainText('e2e-fixture-host-2');
    await expect(idleRow).toContainText('claude-opus-4-8');
    await expect(idleRow).toContainText('3 turns');
    // No PR fixture is registered for the idle session's branch — the
    // GitHub fixture route (api/e2e/github/search/issues) legitimately
    // returns no match, so no "PR #" link should render for this row.
    await expect(idleRow.getByRole('link', { name: /PR #/ })).toHaveCount(0);

    // Finished sessions are history, not activity: they render inside the
    // "Recent CLI sessions" disclosure, collapsed by default...
    const endedRow = page.getByTestId(
      `cli-session-${E2E_CLI_SESSION_IDS.ended}`,
    );
    const staleRow = page.getByTestId(
      `cli-session-${E2E_CLI_SESSION_IDS.stale}`,
    );
    await expect(endedRow).toBeHidden();
    await expect(staleRow).toBeHidden();

    // ...and become visible once expanded.
    await page.getByTestId('recent-sessions').locator('summary').click();
    await expect(endedRow.getByTestId('cli-session-liveness')).toHaveText(
      'ended',
    );
    await expect(endedRow).toContainText('e2e-fixture-host-3');
    await expect(endedRow).toContainText('1 turns');
    await expect(staleRow.getByTestId('cli-session-liveness')).toHaveText(
      'stale',
    );
    await expect(staleRow).toContainText('e2e-fixture-host-4');
    await expect(staleRow).toContainText('2 turns');

    // Liveness badges are distinct per row, not just present somewhere on
    // the page: assert the full set of rendered labels matches exactly
    // {live, idle, ended, stale}, one each.
    await expect(page.getByTestId('cli-session-liveness')).toHaveText([
      'live',
      'idle',
      'ended',
      'stale',
    ]);
  });
});
