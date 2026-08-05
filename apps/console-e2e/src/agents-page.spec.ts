import { expect, test } from '@playwright/test';

import { E2E_CLI_SESSION_IDS, useCliSessionFixtures } from './seed';
import { cliSessionRow, useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();
useCliSessionFixtures();

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
    const header = page.locator('.console-header');
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
    await expect(
      page.getByRole('heading', { name: /Claimed but Idle/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Recent Outcomes' }),
    ).toBeVisible();

    // The seeded live/idle CLI sessions (same fixtures the home page's
    // panel renders) show up here too, via the shared CliSessionRow.
    const liveRow = cliSessionRow(page, E2E_CLI_SESSION_IDS.live);
    await expect(liveRow.getByTestId('cli-session-liveness')).toHaveText(
      'live',
    );
    const idleRow = cliSessionRow(page, E2E_CLI_SESSION_IDS.idle);
    await expect(idleRow.getByTestId('cli-session-liveness')).toHaveText(
      'idle',
    );
    // Ended/stale sessions are history, not active work - they must not
    // appear in the Active Agents section at all (no collapsed disclosure
    // here, unlike the home page's panel).
    await expect(cliSessionRow(page, E2E_CLI_SESSION_IDS.ended)).toHaveCount(0);
    await expect(cliSessionRow(page, E2E_CLI_SESSION_IDS.stale)).toHaveCount(0);

    // No action items are seeded in this environment (see the module doc
    // above), so the claim list is genuinely empty - assert the zero state
    // rather than asserting nothing.
    await expect(page.getByText('Claimed but Idle (0)')).toBeVisible();

    // Cross-link back to the overview (the shared ConsoleHeader nav rail's
    // "Deck" pill, see console-header.tsx).
    await header.getByRole('link', { name: 'Deck' }).click();
    await page.waitForURL('/');
    await expect(
      page.getByRole('heading', { name: 'Command Deck' }),
    ).toBeVisible();
  });

  test('uses the compact operational hierarchy on desktop', async ({
    page,
  }, testInfo) => {
    await page.goto('/agents');

    const header = page.locator('.console-header[data-current="agents"]');
    const workspace = page.getByRole('region', { name: 'Agent operations' });
    await expect(header).toBeVisible();
    await expect(workspace).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Quick task' }),
    ).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();

    expect((await header.boundingBox())?.height).toBeLessThanOrEqual(80);
    await expect(workspace.locator('.agents-workspace__operations')).toHaveCSS(
      'display',
      'grid',
    );
    await expect(workspace.getByTestId('active-agents-section')).toBeVisible();
    await expect(workspace.getByTestId('claimed-idle-section')).toBeVisible();
    await expect(workspace.getByTestId('recent-outcomes')).toBeVisible();

    const capture = testInfo.outputPath('agents-desktop.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('agents-desktop.png', {
      path: capture,
      contentType: 'image/png',
    });
  });

  test('preserves repository scope in header and mobile navigation', async ({
    page,
  }) => {
    await page.goto('/agents?repo=jlapenna%2Fagent-lcars');

    const header = page.locator('.console-header[data-current="agents"]');
    await expect(header.getByRole('link', { name: 'Deck' })).toHaveAttribute(
      'href',
      '/?repo=jlapenna%2Fagent-lcars',
    );
    await expect(header.getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'href',
      '/inbox?repo=jlapenna%2Fagent-lcars',
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Deck' })).toHaveAttribute(
      'href',
      '/?repo=jlapenna%2Fagent-lcars',
    );
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toHaveAttribute(
      'href',
      '/inbox?repo=jlapenna%2Fagent-lcars',
    );
  });

  test('collapses to one mobile command strip and one overflow-safe column', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/agents');

    const header = page.locator('.console-header[data-current="agents"]');
    const workspace = page.getByRole('region', { name: 'Agent operations' });
    await expect(header).toBeVisible();
    await expect(workspace).toBeVisible();
    await expect(header.getByRole('link', { name: 'Agents' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Deck' })).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Quick task' }),
    ).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();
    expect((await header.boundingBox())?.height).toBe(64);

    await expect(workspace.locator('.agents-workspace__operations')).toHaveCSS(
      'display',
      'block',
    );
    const sectionTops = await Promise.all(
      [
        page.getByTestId('fleet-snapshot-bar'),
        page.getByTestId('active-agents-section'),
        page.getByTestId('claimed-idle-section'),
        page.getByTestId('recent-outcomes'),
      ].map(async (locator) => (await locator.boundingBox())?.y ?? -1),
    );
    expect(sectionTops).toEqual([...sectionTops].sort((a, b) => a - b));

    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Deck' })).toBeVisible();
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

    const capture = testInfo.outputPath('agents-mobile.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('agents-mobile.png', {
      path: capture,
      contentType: 'image/png',
    });
  });
});
