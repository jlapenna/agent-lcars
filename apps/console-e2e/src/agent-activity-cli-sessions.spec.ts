import { expect, test } from '@playwright/test';

import {
  E2E_CLI_SESSION_IDS,
  E2E_FIXTURE_PR_NUMBER,
  useCliSessionFixtures,
} from './seed';
import { cliSessionRow, useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();
useCliSessionFixtures();

// @smoke: this is the only spec in the suite so far — it must run in the
// default per-PR smoke lane (E2E_GREP is @smoke|@visual, #2599/#2860), not
// just the run-e2e-labeled full tier.
test.describe('Agent Activity panel CLI sessions @smoke', () => {
  test('renders active sessions with direct actions and leaves history to Sessions', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByText('CLI sessions', { exact: true })).toBeVisible();

    const liveRow = cliSessionRow(page, E2E_CLI_SESSION_IDS.live);
    await expect(liveRow.getByTestId('cli-session-liveness')).toHaveText(
      'live',
    );
    await expect(liveRow).not.toContainText('e2e-fixture-host-1');
    await expect(liveRow).not.toContainText('agent-lcars-e2e-fixture');
    // Bridge rows carry only identity, status, and the action that advances
    // the operator; detailed evidence remains on the session route.
    await expect(liveRow).not.toContainText('claude-sonnet-5');
    await expect(liveRow).not.toContainText('12 turns');
    await expect(liveRow).not.toContainText('12.2k tokens');
    await expect(
      liveRow.getByRole('link', { name: 'Open session' }),
    ).toBeVisible();
    await expect(
      liveRow.getByRole('link', { name: `PR #${E2E_FIXTURE_PR_NUMBER} ↗` }),
    ).toHaveCount(0);

    const idleRow = cliSessionRow(page, E2E_CLI_SESSION_IDS.idle);
    await expect(idleRow.getByTestId('cli-session-liveness')).toHaveText(
      'idle',
    );
    await expect(idleRow).not.toContainText('e2e-fixture-host-2');
    await expect(idleRow).not.toContainText('claude-opus-4-8');
    await expect(idleRow).not.toContainText('3 turns');
    // No PR fixture is registered for the idle session's branch — the
    // GitHub fixture route (api/e2e/github/search/issues) legitimately
    // returns no match, so no "PR #" link should render for this row.
    await expect(idleRow.getByRole('link', { name: /PR #/ })).toHaveCount(0);
    await expect(
      idleRow.getByRole('link', { name: 'Open session' }),
    ).toBeVisible();

    // Finished sessions are history, not Bridge activity, so they are not
    // rendered in a disclosure at all.
    const endedRow = cliSessionRow(page, E2E_CLI_SESSION_IDS.ended);
    const staleRow = cliSessionRow(page, E2E_CLI_SESSION_IDS.stale);
    await expect(endedRow).toHaveCount(0);
    await expect(staleRow).toHaveCount(0);
    await expect(page.getByTestId('recent-sessions')).toHaveCount(0);

    await expect(page.getByTestId('cli-session-liveness')).toHaveText([
      'live',
      'idle',
    ]);
  });
});
