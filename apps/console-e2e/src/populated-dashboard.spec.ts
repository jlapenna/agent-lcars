import { expect, Page, test } from '@playwright/test';

import {
  E2E_ISSUE_AGENT_SESSION_ID,
  E2E_ITEM_NUMBERS,
  usePopulatedFixtures,
} from './seed';
import { expectMobileBridgeHeader } from './util/console-layout';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

/**
 * #40: every screenshot taken during the LCARS redesign (#32) was of an
 * environment with zero action items, zero runs, and zero issue-agent
 * sessions — so terracotta (failed), mustard (timeout), jade (success),
 * magenta (review-requested), and the whole `ACTION_COLORS` badge set had
 * never been rendered against anything at all. Only the nav chrome had.
 *
 * These drive the same pages against the populated fixture set (see
 * `lib/e2e-github-fixtures.ts`) so each of those states is actually
 * exercised, in both color schemes.
 */

/** The console reads the scheme from the cookie its own toggle writes (see
 * layout.tsx), so this is the honest way to render a page in light mode. */
async function useColorScheme(page: Page, scheme: 'light' | 'dark') {
  await page.context().addCookies([
    {
      name: 'mantine-color-scheme',
      value: scheme,
      url: 'http://127.0.0.1:4200',
    },
  ]);
}

useE2eAdminBeforeEach();
usePopulatedFixtures();

test.describe('populated dashboard', () => {
  test('renders each Inbox reason against real items', async ({ page }) => {
    await page.goto('/inbox');

    // The Inbox intentionally exposes one highest-priority semantic reason
    // per row. Deploy-wait-only work remains in the compact tier below.
    for (const label of [
      'Human needed',
      'Ready for agent',
      'Run failed',
      'Review requested',
      'Silent error',
      // #538: the mergeBlockedThreads fixture is the first e2e coverage of
      // this badge's own color at all - every prior `merge-blocked` fixture
      // carried an outstanding review request, which outranks it.
      'Merge blocked',
    ]) {
      await expect(page.getByText(label).first()).toBeVisible();
    }
    await expect(
      page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.readyForAgent}`),
    ).toBeVisible();

    // The silent-error tier only exists because a run's joined session doc
    // contradicts its green conclusion — assert the diagnosis text, not just
    // the badge, since that join is the fragile half.
    await page
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.silentError}`)
      .getByRole('link')
      .click();
    await expect(page.getByTestId('silent-error-diagnosis')).toBeVisible();

    // Deploy-wait-only work remains on the Bridge overview.
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Parked Work' }),
    ).toBeVisible();
  });

  test('surfaces per-item detail that only appears on populated cards', async ({
    page,
  }) => {
    await page.goto('/inbox');

    // `.first()`: the same title also appears on this item's run row in the
    // In Flight panel, which is itself the join working.
    await expect(
      page.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`),
    ).toBeVisible();
    // Failing-check list (run-failed) and the mergeable-state warning
    // (review-requested, `behind`) are detail states no screenshot had
    // shown before the master/detail workspace.
    await page
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.runFailed}`)
      .getByRole('link')
      .click();
    await expect(page.getByText(/^Failed: /).first()).toBeVisible();

    await page
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`)
      .getByRole('link')
      .click();
    await expect(page.getByText(/Base branch has moved/).first()).toBeVisible();

    // #538: a PR blocked (mergeStateStatus BLOCKED) by unresolved review
    // threads, not by anything CI or reviewDecision would show - the
    // "Merge blocked" badge alone doesn't say why; the thread count does.
    await page
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.mergeBlockedThreads}`)
      .getByRole('link')
      .click();
    await expect(
      page.getByText('3 unresolved review threads').first(),
    ).toBeVisible();

    // The takeover command the fleet posts on a claimed item.
    await page
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`)
      .getByRole('link')
      .click();
    await expect(
      page.getByText(/claude-agent-session\.sh resume/).first(),
    ).toBeVisible();
  });

  test('retrigger and pipeline reassignment use broker-safe GitHub writes', async ({
    page,
  }) => {
    await page.goto('/inbox');
    await page
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`)
      .getByRole('link')
      .click();
    const detail = page.locator('.queue-workspace__detail');

    const retrigger = detail.getByRole('button', { name: 'Retrigger' });
    await retrigger.click();
    await page.getByRole('button', { name: 'Retrigger now' }).click();
    await expect(page.getByText('#9001 retriggered')).toBeVisible();
    await expect(retrigger).toBeEnabled();

    const overflow = detail.getByRole('button', {
      name: 'More actions for #9001',
    });
    await overflow.click();
    await page.getByRole('menuitem', { name: 'Reassign to codex' }).click();
    await expect(page.getByText('#9001 reassigned to codex')).toBeVisible();
    // Both controls bind their `useTransition` state to disabled/loading;
    // enabled again is the user-visible proof that the refreshed RSC
    // payload settled before Playwright closes this test's page.
    await expect(overflow).toBeEnabled();
  });

  test('edits issue content from the shared three-dot menu across dashboard surfaces', async ({
    page,
  }) => {
    const updatedTitle = 'Choose the archive retention window';
    const updatedBody = 'Pick 30 or 90 days before the watcher ships.';

    await page.goto('/inbox');
    await page
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.humanNeeded}`)
      .getByRole('link')
      .click();
    const detail = page.locator('.queue-workspace__detail');
    await detail
      .getByRole('button', { name: 'More actions for #9001' })
      .click();
    await page.getByRole('menuitem', { name: 'Edit issue' }).click();

    const editor = page.getByRole('dialog', { name: 'Edit #9001' });
    await expect(editor.getByLabel('Title')).toHaveValue(
      'Decide the retention window for archived agent transcripts',
    );
    await expect(editor.getByLabel('Body')).toHaveValue(
      'The archive TTL was never settled. Needs a call before the watcher ships.',
    );
    await editor.getByLabel('Title').fill(updatedTitle);
    await editor.getByLabel('Body').fill(updatedBody);
    await editor.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByText('#9001 updated')).toBeVisible();
    await expect(editor).toBeHidden();
    await expect(detail.getByText(updatedTitle)).toBeVisible();

    // The canonical task detail is a separate route backed by a direct
    // issue lookup rather than the open-item board, but it exposes the same
    // mutation menu and persisted content too.
    await page.goto(
      `/task/supersprinklesracing/sprinkles/${E2E_ITEM_NUMBERS.humanNeeded}`,
    );
    await page.getByRole('button', { name: 'More actions for #9001' }).click();
    await page.getByRole('menuitem', { name: 'Edit issue' }).click();
    const taskEditor = page.getByRole('dialog', { name: 'Edit #9001' });
    await expect(taskEditor.getByLabel('Title')).toHaveValue(updatedTitle);
    await expect(taskEditor.getByLabel('Body')).toHaveValue(updatedBody);
    await taskEditor.getByRole('button', { name: 'Cancel' }).click();

    // Claimed-but-idle rows are the remaining ActionItem surface and now
    // carry the shared overflow menu alongside their optional session link.
    await page.goto('/agents');
    const claimedIdle = page.getByTestId('claimed-idle-section');
    await claimedIdle
      .getByRole('button', { name: 'More actions for #9001' })
      .click();
    await page.getByRole('menuitem', { name: 'Edit issue' }).click();
    const agentsEditor = page.getByRole('dialog', { name: 'Edit #9001' });
    await expect(agentsEditor.getByLabel('Title')).toHaveValue(updatedTitle);
    await expect(agentsEditor.getByLabel('Body')).toHaveValue(updatedBody);
  });

  test('renders live and finished run rows across the status palette', async ({
    page,
  }) => {
    await page.goto('/');

    // Live: a running row (with its elapsed/turn gauges) and a queued row
    // stalled past the threshold, which is what drives the queue alert.
    await expect(page.getByTestId('queue-health-alert')).toBeVisible();
    await expect(page.getByTestId('fleet-chip')).toHaveText(
      '2 runners active (1 busy)',
    );

    // #306: the fixture's duplicate live attempt on the same issue/pipeline
    // is no longer collapsed away - both rows render, grouped under one
    // visible duplicate-attempt anomaly, never silently reduced to one.
    const duplicateGroup = page.getByTestId(
      `live-run-group-${E2E_ITEM_NUMBERS.ledgerDuplicateDispatch}`,
    );
    await expect(duplicateGroup).toBeVisible();
    await expect(duplicateGroup.getByTestId('current-run-row')).toHaveCount(2);
    await expect(duplicateGroup).not.toContainText('[dispatch:');
    const duplicateAlert = page.getByTestId(
      `live-run-group-${E2E_ITEM_NUMBERS.ledgerDuplicateDispatch}-duplicate`,
    );
    await expect(duplicateAlert).toBeVisible();
    await expect(duplicateAlert).toContainText('2 claude');

    // The five latest outcomes are visible immediately, without expanding
    // a remembered disclosure.
    const recent = page.getByTestId('latest-outcomes');
    await expect(recent).toBeVisible();

    // success / failed / timeout: the three data colors #40 calls out as
    // never having been seen.
    await expect(recent.getByText('success').first()).toBeVisible();
    await expect(recent.getByText('failed').first()).toBeVisible();
    await expect(recent.getByText('timeout').first()).toBeVisible();
    // Pipeline source tags stay on the deeper Agents evidence view.
    await expect(recent.getByText('opencode', { exact: true })).toHaveCount(0);
  });

  test('the primary Open task action reaches the canonical task page with the ledger-backed anomaly (#306)', async ({
    page,
  }) => {
    await page.goto('/');

    const duplicateGroup = page.getByTestId(
      `live-run-group-${E2E_ITEM_NUMBERS.ledgerDuplicateDispatch}`,
    );
    const primaryAction = duplicateGroup
      .getByTestId('current-run-primary-action')
      .first();
    await expect(primaryAction).toHaveText('Open task');
    await primaryAction.click();

    await expect(page).toHaveURL(
      new RegExp(
        `/task/supersprinklesracing/sprinkles/${E2E_ITEM_NUMBERS.ledgerDuplicateDispatch}$`,
      ),
    );

    const card = page.getByTestId('logical-work-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('logical-work-state')).toHaveText('anomaly');
    await expect(card).toContainText('authoritative state rev');

    // Both attempts remain visible on the canonical task page too - the
    // ledger explains WHY they exist (one generation, one intent), the
    // anomaly banner explains why there are two of them.
    const attempts = card.getByTestId('logical-work-attempts');
    await expect(attempts.getByText(/queued/).first()).toBeVisible();
    await expect(attempts.getByText(/running/).first()).toBeVisible();

    const anomalies = card.getByTestId('logical-work-anomalies');
    await expect(anomalies).toContainText('2 claude attempts');

    const intents = card.getByTestId('logical-work-intents');
    await expect(intents).toBeVisible();
    await expect(intents).toContainText('g1');
    await expect(intents).toContainText('via labeled');
  });

  test('renders the sessions archive and an issue-agent detail page', async ({
    page,
  }) => {
    await page.goto('/sessions');

    const row = page.getByTestId(`session-row-${E2E_ISSUE_AGENT_SESSION_ID}`);
    await expect(row).toBeVisible();
    // The `agent` source badge — the issue-agent half of SourceBadge, which
    // no seeded fixture produced before this one. `exact` because the
    // session title contains the substring "issue-agent" too.
    await expect(row.getByText('agent', { exact: true })).toBeVisible();

    await page.goto(`/sessions/${E2E_ISSUE_AGENT_SESSION_ID}`);
    const header = page.getByTestId('session-header');
    await expect(header).toBeVisible();
    await expect(header.getByText('agent', { exact: true })).toBeVisible();
    // The stat grid, rendered against a real doc rather than a unit-test
    // fixture: model, turns, tokens, cost, and the issue-agent-only Run /
    // Issue links.
    await expect(header.getByText('claude-opus-5')).toBeVisible();
    // `exact`, and the post-#111 label: the stat grid now says
    // "Cost-weighted tokens", so a substring match on "Cost" hits that
    // label, the "Cost" field, and the weighted total in the value itself.
    await expect(
      header.getByText('Cost-weighted tokens', { exact: true }),
    ).toBeVisible();
    await expect(header.getByText('Cost', { exact: true })).toBeVisible();
    await expect(
      header.getByRole('link', { name: `#${E2E_ITEM_NUMBERS.silentError}` }),
    ).toBeVisible();
  });

  test('keeps older issue groups behind one phone disclosure @sessions-mobile-history', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/sessions');

    const disclosure = page.getByTestId('issue-grouped-sessions');
    const visibleGroups = disclosure.locator(
      '[data-testid^="issue-group-"]:visible',
    );
    await expect(visibleGroups).toHaveCount(5);

    const toggle = disclosure.getByRole('button', {
      name: 'Show 6 older issue groups',
    });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(disclosure).toHaveAttribute('data-expanded', 'true');
    await expect(visibleGroups).toHaveCount(11);
    await disclosure
      .getByRole('button', { name: 'Show fewer issue groups' })
      .click();
    await expect(visibleGroups).toHaveCount(5);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const capture = testInfo.outputPath('sessions-mobile-history.png');
    await page.screenshot({ path: capture, fullPage: true });
    await testInfo.attach('sessions-mobile-history.png', {
      path: capture,
      contentType: 'image/png',
    });
  });
});

test.describe('responsive decision inbox', () => {
  test('keeps the Bridge focused on overview work', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Bridge' })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Decision Inbox' }),
    ).toHaveCount(0);
    const header = page.locator('.console-header[data-current="deck"]');
    await expect(header.getByRole('link', { name: 'Bridge' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(header.getByRole('link', { name: 'Inbox' })).toBeVisible();
  });

  test('keeps list selection URL-addressable on desktop', async ({ page }) => {
    await page.goto('/inbox');

    const workspace = page.getByRole('region', { name: 'Decision Inbox' });
    const header = page.locator(
      '.console-header[data-current="inbox"]:not([data-streaming-fallback])',
    );
    await expect(
      header.getByRole('heading', { level: 1, name: 'Decision Inbox' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(workspace.locator('.queue-workspace__detail')).toBeVisible();

    await workspace
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`)
      .getByRole('link')
      .click();

    await expect(page).toHaveURL(
      new RegExp(`\\bitem=[^&]*${E2E_ITEM_NUMBERS.reviewRequested}`),
    );
    await expect(
      workspace.getByText('Base branch has moved', { exact: false }),
    ).toBeVisible();
  });

  test('preserves repository scope between Deck and Inbox navigation', async ({
    page,
  }) => {
    const repoQuery = 'supersprinklesracing%2Fsprinkles';
    await page.goto(`/?repo=${repoQuery}`);

    const header = page.locator('.console-header');
    const inboxLink = header.getByRole('link', { name: 'Inbox' });
    await expect(inboxLink).toHaveAttribute('href', `/inbox?repo=${repoQuery}`);
    await inboxLink.click();
    await expect(page).toHaveURL(new RegExp(`/inbox\\?repo=${repoQuery}$`));
    await expect(header.getByRole('link', { name: 'Bridge' })).toHaveAttribute(
      'href',
      `/?repo=${repoQuery}`,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Bridge' }),
    ).toHaveAttribute('href', `/?repo=${repoQuery}`);
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toHaveAttribute(
      'href',
      `/inbox?repo=${repoQuery}`,
    );
  });

  test('keeps the Inbox workspace and navigation usable on a tablet', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/inbox');

    const header = page.locator('.console-header[data-current="inbox"]');
    const workspace = page.getByRole('region', { name: 'Decision Inbox' });
    await expect(header).toBeVisible();
    await expect(header.getByRole('link', { name: 'Inbox' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Bridge' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Agents' })).toBeVisible();
    await expect(workspace.locator('.queue-workspace__list')).toBeVisible();
    await expect(workspace.locator('.queue-workspace__detail')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Bridge' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toBeVisible();
    await page.keyboard.press('Escape');
    await testInfo.attach('inbox-tablet.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('exposes an operable keyboard and semantic Inbox workflow', async ({
    page,
  }) => {
    await page.goto('/inbox');

    const workspace = page.getByRole('region', { name: 'Decision Inbox' });
    const rowLink = workspace
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`)
      .getByRole('link');
    await rowLink.focus();
    await expect(rowLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(
      new RegExp(`\\bitem=[^&]*${E2E_ITEM_NUMBERS.reviewRequested}`),
    );

    const filter = workspace.getByRole('button', { name: 'Filter and sort' });
    await filter.focus();
    await page.keyboard.press('Enter');
    const choices = page.getByRole('menuitem');
    await expect(choices).toHaveCount(10);
    await expect(
      page.getByRole('menuitem', { name: 'All reasons' }),
    ).toHaveAttribute('aria-current', 'true');
    await expect(
      page.getByRole('menuitem', { name: 'Ready for agent' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(filter).toBeFocused();
  });

  test('uses a list-to-detail flow on a phone viewport', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/inbox');

    const workspace = page.getByRole('region', { name: 'Decision Inbox' });
    const header = page.locator('.console-header[data-current="inbox"]');
    // The shared title-inside-the-elbow header now owns Inbox identity at every
    // viewport; route navigation remains available inside its overflow menu.
    await expectMobileBridgeHeader(header);
    await expect(
      header.getByRole('heading', { name: 'Decision Inbox' }),
    ).toBeVisible();
    await expect(workspace.locator('.queue-workspace__list')).toBeVisible();
    await expect(workspace.locator('.queue-workspace__detail')).toBeHidden();
    await expect(
      workspace.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`),
    ).toBeVisible();

    await expect(page.getByTestId('inbox-mobile-command-deck')).toHaveCount(0);

    const freshness = page.getByTestId('mobile-data-freshness');
    await expect(freshness).toBeVisible();
    await expect(freshness).toHaveText(/^Updated /);
    expect(
      await freshness.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);

    const runningRow = workspace.getByTestId(
      `queue-row-${E2E_ITEM_NUMBERS.runFailed}`,
    );
    await expect(
      runningRow.getByRole('status', { name: 'CI running' }),
    ).toBeVisible();
    await expect(runningRow.locator('.ci-running-badge')).toHaveCount(0);

    const search = workspace.getByRole('textbox', {
      name: 'Search the Inbox',
    });
    const searchBounds = await search.boundingBox();
    expect(searchBounds?.width).toBeGreaterThan(340);
    await expect(
      workspace.getByRole('button', { name: 'Filter and sort' }),
    ).toHaveCSS('min-height', '44px');

    await workspace.getByRole('button', { name: 'Filter and sort' }).click();
    const filterItems = page.getByRole('menuitem');
    const undersizedFilterItems = await filterItems.evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect().height)
        .filter((height) => height < 44),
    );
    expect(undersizedFilterItems).toEqual([]);
    await page.getByRole('menuitem', { name: 'Newest update' }).click();
    await expect(page).toHaveURL(/sort=newest/);

    const capture = testInfo.outputPath('inbox-mobile-polished.png');
    await page.screenshot({ path: capture, fullPage: false });
    await testInfo.attach('inbox-mobile-polished.png', {
      path: capture,
      contentType: 'image/png',
    });

    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Agents' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');

    await workspace
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`)
      .getByRole('link')
      .click();

    await expect(workspace.locator('.queue-workspace__list')).toBeHidden();
    await expect(workspace.locator('.queue-workspace__detail')).toBeVisible();
    await expect(header).toBeVisible();
    await expect(freshness).toBeVisible();
    await expect(workspace.locator('.queue-mobile-bar')).toHaveCSS(
      'height',
      '52px',
    );
    await expect(workspace.locator('.queue-detail-identity')).toBeHidden();
    await expect(workspace.locator('.queue-mobile-detail-identity')).toHaveText(
      `sprinkles / #${E2E_ITEM_NUMBERS.reviewRequested}`,
    );
    const replyInput = workspace.getByPlaceholder(/Reply/);
    await expect(replyInput).toBeVisible();
    expect((await replyInput.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(
      (await workspace.getByRole('button', { name: 'Reply' }).boundingBox())
        ?.height,
    ).toBeGreaterThanOrEqual(44);
    const backLink = workspace.getByRole('link', {
      name: 'Back to Inbox list',
      exact: true,
    });
    await expect(backLink).toBeVisible();

    await backLink.click();
    await expect(page).not.toHaveURL(/\bitem=/);
    await expect(workspace.locator('.queue-workspace__list')).toBeVisible();
  });

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
  ]) {
    test(`keeps the action-first Bridge usable at ${viewport.width}px @mobile-deep`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto('/');

      const header = page.locator('.console-header[data-current="deck"]');
      await expect(header).toBeVisible();
      await expect(header.getByRole('link', { name: 'Bridge' })).toBeHidden();
      await expect(header.getByRole('link', { name: 'Inbox' })).toBeHidden();
      await expectMobileBridgeHeader(header);
      await expect(
        page.getByRole('region', { name: 'Decision Inbox' }),
      ).toHaveCount(0);
      await expect(page.getByTestId('deck-inbox-summary')).toBeVisible();
      await expect(page.getByTestId('current-work')).toBeVisible();
      await expect(page.getByTestId('latest-outcomes')).toBeVisible();
      await expect(page.getByTestId('finished-run-row')).toHaveCount(5);

      const directActions = page.locator(
        '.deck-inbox-summary__action:visible, .operations-panel a:visible, .operations-panel button:visible',
      );
      expect(await directActions.count()).toBeGreaterThan(1);
      const badActions = await directActions.evaluateAll((elements) =>
        elements
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              label: element.textContent?.trim() ?? element.tagName,
              width: box.width,
              height: box.height,
              left: box.left,
              right: box.right,
            };
          })
          .filter(
            ({ width, height, left, right }) =>
              width < 44 ||
              height < 44 ||
              left < -0.5 ||
              right > window.innerWidth + 0.5,
          ),
      );
      expect(badActions).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      await page.getByRole('button', { name: 'More console options' }).click();
      await expect(
        page.getByRole('menu').getByRole('menuitem', { name: 'Inbox' }),
      ).toBeVisible();
    });
  }
});

test.describe('responsive agent operations', () => {
  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
  ]) {
    test(`keeps the populated Agents page usable at ${viewport.width}px @agents-mobile`, async ({
      page,
    }, testInfo) => {
      const browserErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(message.text());
      });
      page.on('pageerror', (error) => browserErrors.push(error.message));

      await page.setViewportSize(viewport);
      await page.goto('/agents');

      const workspace = page.getByRole('region', {
        name: 'Agent operations',
      });
      await expect(workspace).toBeVisible();
      await expect(workspace.getByTestId('fleet-snapshot-bar')).toBeVisible();
      await expect(
        workspace.getByTestId('active-agents-section'),
      ).toBeVisible();
      await expect(workspace.getByTestId('claimed-idle-section')).toBeVisible();
      await expect(workspace.getByTestId('recent-outcomes')).toBeVisible();

      const outcomes = workspace.getByTestId('recent-outcomes');
      const outcomesDisclosure = outcomes.getByTestId(
        'recent-outcomes-disclosure',
      );
      await expect(
        outcomes.locator('[data-testid="finished-run-row"]:visible'),
      ).toHaveCount(5);
      const olderOutcomes = outcomes.getByRole('button', {
        name: /Show \d+ older outcomes/,
      });
      await expect(olderOutcomes).toBeVisible();
      await olderOutcomes.click();
      await expect(outcomesDisclosure).toHaveAttribute('data-expanded', 'true');
      expect(
        await outcomes
          .locator('[data-testid="finished-run-row"]:visible')
          .count(),
      ).toBeGreaterThan(5);
      await outcomes
        .getByRole('button', { name: 'Show fewer outcomes' })
        .click();
      await expect(
        outcomes.locator('[data-testid="finished-run-row"]:visible'),
      ).toHaveCount(5);

      const operations = workspace.locator('.agents-workspace__operations');
      await expect(operations).toHaveCSS('display', 'block');
      const sections = [
        workspace.getByTestId('fleet-snapshot-bar'),
        workspace.getByTestId('active-agents-section'),
        workspace.getByTestId('claimed-idle-section'),
        workspace.getByTestId('recent-outcomes'),
      ];
      const sectionBounds = await Promise.all(
        sections.map(async (section) => section.boundingBox()),
      );
      expect(
        sectionBounds.every(
          (bounds) => (bounds?.width ?? 0) >= viewport.width - 10,
        ),
      ).toBe(true);
      const sectionTops = sectionBounds.map((bounds) => bounds?.y ?? -1);
      expect(sectionTops).toEqual([...sectionTops].sort((a, b) => a - b));

      const badControls = await page
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
                left: box.left,
                right: box.right,
              };
            })
            .filter(
              ({ width, height, left, right }) =>
                width < 44 ||
                height < 44 ||
                left < -0.5 ||
                right > window.innerWidth + 0.5,
            ),
        );
      expect(badControls).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(browserErrors).toEqual([]);

      await page.getByRole('button', { name: 'More console options' }).click();
      await expect(
        page.getByRole('menu').getByRole('menuitem', { name: 'Sessions' }),
      ).toBeVisible();
      await page.keyboard.press('Escape');

      const filename = `agents-populated-${viewport.width}px.png`;
      const capture = testInfo.outputPath(filename);
      await page.screenshot({ path: capture, fullPage: true });
      await testInfo.attach(filename, {
        path: capture,
        contentType: 'image/png',
      });
    });
  }

  test('keeps populated agent columns balanced on tablet @agents-mobile', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/agents');

    const workspace = page.getByRole('region', { name: 'Agent operations' });
    const operations = workspace.locator('.agents-workspace__operations');
    await expect(operations).toHaveCSS('display', 'grid');
    const primary = await workspace
      .locator('.agents-workspace__primary')
      .boundingBox();
    const secondary = await workspace
      .locator('.agents-workspace__secondary')
      .boundingBox();
    expect(primary?.width).toBeGreaterThan(400);
    expect(secondary?.width).toBeGreaterThanOrEqual(320);
    expect(primary?.x).toBeLessThan(secondary?.x ?? 0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});

// Screenshots, not assertions: #40 asks for the populated pages to be looked
// at in both schemes, so these capture them on every run and nothing here
// fails on appearance. Deliberately NOT `toHaveScreenshot` baselines — this
// suite has no committed baselines and CI's rendering environment isn't
// pinned to a developer's, so a baseline here would be a flake generator.
//
// Written via `testInfo.outputPath()` and attached with `testInfo.attach()`
// rather than to a cwd-relative path: an attachment is embedded in the
// Playwright HTML report, which is the artifact CI actually uploads (see
// ci.yml, which uploads it on success too precisely so these are
// retrievable after a green run — a capture nobody can open isn't a
// capture).
test.describe('populated page captures', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`captures the console in ${scheme} mode`, async ({
      page,
    }, testInfo) => {
      await useColorScheme(page, scheme);
      // The session detail page is a drill-down, not a nav destination, so
      // it renders its own back-link header instead of the pill rail (see
      // ConsoleHeader's doc comment) — each page gets its own readiness
      // marker rather than one shared nav assertion.
      for (const [name, path, ready] of [
        ['deck', '/', '[data-testid="current-work"]'],
        [
          'inbox',
          '/inbox',
          '.console-header[data-current="inbox"]:not([data-streaming-fallback])',
        ],
        [
          'agents',
          '/agents',
          '.console-header[data-current="agents"]:not([data-streaming-fallback])',
        ],
        [
          'sessions',
          '/sessions',
          '.console-header[data-current="sessions"]:not([data-streaming-fallback])',
        ],
        [
          'session-detail',
          `/sessions/${E2E_ISSUE_AGENT_SESSION_ID}`,
          '[data-testid="session-header"]',
        ],
      ] as const) {
        await page.goto(path);
        await expect(page.locator(ready)).toBeVisible();
        const file = `${name}-${scheme}.png`;
        const capture = testInfo.outputPath(file);
        await page.screenshot({ path: capture, fullPage: true });
        await testInfo.attach(file, {
          path: capture,
          contentType: 'image/png',
        });
      }
    });
  }

  test('captures the phone list and detail flow', async ({
    page,
  }, testInfo) => {
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const header = page.locator('.console-header[data-current="deck"]');
    await expectMobileBridgeHeader(header);
    await expect(header.getByRole('heading', { name: 'Bridge' })).toBeVisible();
    await expect(page.getByTestId('deck-inbox-summary')).toBeVisible();
    await expect(page.getByTestId('current-work')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const decisionAction = await page
      .getByTestId('deck-inbox-summary')
      .getByRole('link')
      .boundingBox();
    const taskAction = await page
      .getByRole('link', { name: 'Open task' })
      .first()
      .boundingBox();
    expect(decisionAction?.height).toBeGreaterThanOrEqual(44);
    expect(taskAction?.height).toBeGreaterThanOrEqual(44);
    expect(browserErrors).toEqual([]);
    const deckCapture = testInfo.outputPath('deck-mobile.png');
    await page.screenshot({ path: deckCapture });
    await testInfo.attach('deck-mobile.png', {
      path: deckCapture,
      contentType: 'image/png',
    });

    await page.goto('/inbox');
    await expect(
      page.getByRole('region', { name: 'Decision Inbox' }),
    ).toBeVisible();

    await expect(page.locator('.queue-workspace__list')).toBeVisible();
    const listCapture = testInfo.outputPath('inbox-mobile-list.png');
    await page.screenshot({ path: listCapture });
    await testInfo.attach('inbox-mobile-list.png', {
      path: listCapture,
      contentType: 'image/png',
    });

    await page
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`)
      .getByRole('link')
      .click();
    await expect(page.locator('.queue-workspace__detail')).toBeVisible();
    const detailCapture = testInfo.outputPath('inbox-mobile-detail.png');
    await page.screenshot({ path: detailCapture });
    await testInfo.attach('inbox-mobile-detail.png', {
      path: detailCapture,
      contentType: 'image/png',
    });
  });

  test('captures the Inbox list and detail at narrow-phone width', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/inbox');

    const workspace = page.getByRole('region', { name: 'Decision Inbox' });
    await expect(workspace).toBeVisible();
    await expect(
      workspace.getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const listCapture = testInfo.outputPath('inbox-narrow-list.png');
    await page.screenshot({ path: listCapture });
    await testInfo.attach('inbox-narrow-list.png', {
      path: listCapture,
      contentType: 'image/png',
    });

    await workspace
      .getByTestId(`queue-row-${E2E_ITEM_NUMBERS.reviewRequested}`)
      .getByRole('link')
      .click();
    await expect(workspace.locator('.queue-workspace__detail')).toBeVisible();
    await expect(workspace.locator('.queue-detail-identity')).toBeHidden();
    const detailCapture = testInfo.outputPath('inbox-narrow-detail.png');
    await page.screenshot({ path: detailCapture });
    await testInfo.attach('inbox-narrow-detail.png', {
      path: detailCapture,
      contentType: 'image/png',
    });
  });
});
