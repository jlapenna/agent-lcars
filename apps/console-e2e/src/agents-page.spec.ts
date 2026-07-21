import { expect, test } from '@playwright/test';

import { E2E_CLI_SESSION_IDS, resetCliSessions, seedCliSessions } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();

test.beforeEach(async () => {
  await resetCliSessions();
  await seedCliSessions();
});

test.afterAll(async () => {
  await resetCliSessions();
});

// @smoke: a minimal render check for the new agent-focused /agents route
// (#3024) - every section is present and the seeded CLI sessions (shared
// with the home page's fixture, see seed.ts) render inside Active Agents,
// proving the section correctly reuses agent-activity-panel's row
// components. getActionItems() always returns an empty list in this e2e
// environment (the github fixture route at api/e2e/github only answers the
// branch->PR search getCliSessions() needs, not the action-item search
// queries - see that route's own doc comment), so Claimed but Idle is
// exercised only via its unit tests (claimed-idle.test.ts), not here.
test.describe('/agents page @smoke', () => {
  test('renders every section, cross-links to home, and lists active CLI sessions', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('link', { name: 'Agent status →' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Agent status →' }).click();
    await page.waitForURL('/agents');

    await expect(
      page.getByRole('heading', { name: 'Agent Status' }),
    ).toBeVisible();
    await expect(page.getByTestId('fleet-snapshot-bar')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Active Agents' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Claimed but Idle/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Recent Outcomes' }),
    ).toBeVisible();

    // The seeded live/idle CLI sessions (same fixtures the home page's
    // panel renders) show up here too, via the shared CliSessionRow.
    const liveRow = page.getByTestId(`cli-session-${E2E_CLI_SESSION_IDS.live}`);
    await expect(liveRow.getByTestId('cli-session-liveness')).toHaveText(
      'live',
    );
    const idleRow = page.getByTestId(`cli-session-${E2E_CLI_SESSION_IDS.idle}`);
    await expect(idleRow.getByTestId('cli-session-liveness')).toHaveText(
      'idle',
    );
    // Ended/stale sessions are history, not active work - they must not
    // appear in the Active Agents section at all (no collapsed disclosure
    // here, unlike the home page's panel).
    await expect(
      page.getByTestId(`cli-session-${E2E_CLI_SESSION_IDS.ended}`),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(`cli-session-${E2E_CLI_SESSION_IDS.stale}`),
    ).toHaveCount(0);

    // No action items are seeded in this environment (see the module doc
    // above), so the claim list is genuinely empty - assert the zero state
    // rather than asserting nothing.
    await expect(page.getByText('Claimed but Idle (0)')).toBeVisible();

    // Cross-link back to the maintainer task queue.
    await page.getByRole('link', { name: '← Task queue' }).click();
    await page.waitForURL('/');
    await expect(
      page.getByRole('heading', { name: 'Agent LCARS' }),
    ).toBeVisible();
  });
});
