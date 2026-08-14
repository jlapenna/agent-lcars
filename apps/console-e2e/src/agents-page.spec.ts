import { expect, test } from '@playwright/test';

import { E2E_CLI_SESSION_IDS, useCliSessionFixtures } from './seed';
import {
  expectConcentricLcarsElbows,
  expectDesktopBridgeHeader,
  expectMobileBridgeHeader,
} from './util/console-layout';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();
useCliSessionFixtures();

// @smoke: a minimal render check for the new agent-focused /agents route
// (#3024) - active agent rows are the working set; no-result secondary
// panels intentionally disappear so the seeded CLI sessions can own the
// first viewport. getActionItems() always returns an empty list in this e2e
// environment (the github fixture route at api/e2e/github only answers the
// branch->PR search getCliSessions() needs, not the action-item search
// queries - see that route's own doc comment), so stale claims are exercised
// only via their focused unit tests.
test.describe('/agents page @smoke', () => {
  test('renders activity, cross-links to home, and lists active CLI sessions', async ({
    page,
  }) => {
    await page.goto('/');
    const header = page.locator(
      '.console-header:not([data-streaming-fallback])',
    );
    await expect(header).toHaveCount(1);
    await expect(header.getByRole('link', { name: 'Agents' })).toBeVisible();
    await header.getByRole('link', { name: 'Agents' }).click();
    await page.waitForURL('/agents');

    await expect(
      page.getByRole('heading', { name: 'Agent Status' }),
    ).toBeVisible();
    await expect(page.getByTestId('fleet-snapshot-bar')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Active Agents' }),
    ).toBeVisible();
    await expect(page.getByTestId('claimed-idle-section')).toHaveCount(0);
    await expect(page.getByTestId('recent-outcomes')).toHaveCount(0);

    // Cache Components intentionally preserve the previous route's DOM in
    // a hidden React Activity boundary during client navigation. Scope
    // test-id queries to the visible destination section: role queries do
    // this automatically, while getByTestId also sees the cached Deck row.
    const activeAgents = page.getByTestId('active-agents-section');
    // The seeded live/idle CLI sessions (same fixtures the home page's
    // panel renders) show up here too, via the shared CliSessionRow.
    const liveRow = activeAgents.getByTestId(
      `cli-session-${E2E_CLI_SESSION_IDS.live}`,
    );
    await expect(liveRow.getByTestId('cli-session-liveness')).toHaveText(
      'live',
    );
    const idleRow = activeAgents.getByTestId(
      `cli-session-${E2E_CLI_SESSION_IDS.idle}`,
    );
    await expect(idleRow.getByTestId('cli-session-liveness')).toHaveText(
      'idle',
    );
    // Ended/stale sessions are history, not active work - they must not
    // appear in the Active Agents section at all (no collapsed disclosure
    // here, unlike the home page's panel).
    await expect(
      activeAgents.getByTestId(`cli-session-${E2E_CLI_SESSION_IDS.ended}`),
    ).toHaveCount(0);
    await expect(
      activeAgents.getByTestId(`cli-session-${E2E_CLI_SESSION_IDS.stale}`),
    ).toHaveCount(0);

    // Cross-link back to the overview (the shared ConsoleHeader nav rail's
    // "Bridge" pill, see console-header.tsx).
    await header.getByRole('link', { name: 'Bridge' }).click();
    await page.waitForURL('/');
    await expect(page.getByRole('heading', { name: 'Bridge' })).toBeVisible();
  });

  test('uses the compact operational hierarchy on desktop', async ({
    page,
  }) => {
    await page.goto('/agents');

    const header = page.locator(
      '.console-header[data-current="agents"]:not([data-streaming-fallback])',
    );
    const workspace = page.getByRole('region', { name: 'Agent operations' });
    await expect(header).toHaveCount(1);
    await expectDesktopBridgeHeader(header);
    await expect(workspace).toBeVisible();
    await expectConcentricLcarsElbows(
      workspace.locator('.lcars-panel:not(.agents-panel)'),
      8,
    );
    await expect(
      page.getByRole('button', { name: 'Quick task' }),
    ).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();

    await expect(workspace.locator('.agents-workspace__operations')).toHaveCSS(
      'display',
      'block',
    );
    await expect(workspace.getByTestId('active-agents-section')).toBeVisible();
    await expect(workspace.getByTestId('claimed-idle-section')).toHaveCount(0);
    await expect(workspace.getByTestId('recent-outcomes')).toHaveCount(0);
  });

  test('preserves repository scope in header and mobile navigation', async ({
    page,
  }) => {
    await page.goto('/agents?repo=supersprinklesracing%2Fsprinkles');

    const header = page.locator(
      '.console-header[data-current="agents"]:not([data-streaming-fallback])',
    );
    await expect(header).toHaveCount(1);
    await expect(header.getByRole('link', { name: 'Bridge' })).toHaveAttribute(
      'href',
      '/?repo=supersprinklesracing%2Fsprinkles',
    );
    await expect(header.getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'href',
      '/inbox?repo=supersprinklesracing%2Fsprinkles',
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Bridge' }),
    ).toHaveAttribute('href', '/?repo=supersprinklesracing%2Fsprinkles');
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toHaveAttribute(
      'href',
      '/inbox?repo=supersprinklesracing%2Fsprinkles',
    );
  });

  test('uses the shared elbow header and one overflow-safe mobile column', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/agents');

    const header = page.locator(
      '.console-header[data-current="agents"]:not([data-streaming-fallback])',
    );
    const workspace = page.getByRole('region', { name: 'Agent operations' });
    await expect(header).toHaveCount(1);
    await expectMobileBridgeHeader(header);
    await expect(workspace).toBeVisible();
    await expectConcentricLcarsElbows(
      workspace.locator('.lcars-panel:not(.agents-panel)'),
      8,
    );
    await expect(header.getByRole('link', { name: 'Agents' })).toBeHidden();
    await expect(header.getByRole('link', { name: 'Bridge' })).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Quick task' }),
    ).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();

    await expect(workspace.locator('.agents-workspace__operations')).toHaveCSS(
      'display',
      'block',
    );
    const sectionTops = await Promise.all(
      [
        page.getByTestId('fleet-snapshot-bar'),
        page.getByTestId('active-agents-section'),
      ].map(async (locator) => (await locator.boundingBox())?.y ?? -1),
    );
    expect(sectionTops).toEqual([...sectionTops].sort((a, b) => a - b));

    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Bridge' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: 'Sessions' }),
    ).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');

    const undersizedControls = await page
      .locator(
        '.console-header[data-current="agents"] a:visible, .console-header[data-current="agents"] button:visible, .agents-workspace a:visible, .agents-workspace button:visible',
      )
      .evaluateAll((elements) =>
        elements
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              label:
                element.getAttribute('aria-label') ??
                element.textContent?.trim() ??
                element.tagName,
              width: box.width,
              height: box.height,
            };
          })
          .filter(({ width, height }) => width < 44 || height < 44),
      );
    expect(undersizedControls).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
