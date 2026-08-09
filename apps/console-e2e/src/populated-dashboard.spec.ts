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
      page.getByRole('heading', { name: /Waiting on Next Deploy/ }),
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

    // The Bridge intentionally excludes decision work like #9001; its
    // deploy-wait tier still renders the same shared ItemOverflowMenu. Edit
    // that surface's own issue through the same production path.
    await page.goto('/');
    await page.getByRole('button', { name: 'More actions for #9004' }).click();
    await page.getByRole('menuitem', { name: 'Edit issue' }).click();
    const bridgeEditor = page.getByRole('dialog', { name: 'Edit #9004' });
    await expect(bridgeEditor.getByLabel('Title')).toHaveValue(
      'Verify the session-cost budget alert after the next deploy',
    );
    await expect(bridgeEditor.getByLabel('Body')).toHaveValue(
      'Parked until the alert ships to production.',
    );
    await bridgeEditor
      .getByLabel('Title')
      .fill('Verify the deployed session-cost alert');
    await bridgeEditor
      .getByLabel('Body')
      .fill('Run the production verification after deploy.');
    await bridgeEditor.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('#9004 updated')).toBeVisible();
    await expect(
      page.getByText('Verify the deployed session-cost alert'),
    ).toBeVisible();

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
    await expect(duplicateGroup.getByTestId('live-run-issue-link')).toHaveCount(
      2,
    );
    const duplicateAlert = page.getByTestId(
      `live-run-group-${E2E_ITEM_NUMBERS.ledgerDuplicateDispatch}-duplicate`,
    );
    await expect(duplicateAlert).toBeVisible();
    await expect(duplicateAlert).toContainText('2 claude');

    // Finished runs live behind a collapsed <details> — which is itself
    // why these badges had never been looked at.
    const recent = page.getByTestId('recent-runs');
    await recent.locator('summary').click();

    // success / failed / timeout: the three data colors #40 calls out as
    // never having been seen.
    await expect(recent.getByText('success').first()).toBeVisible();
    await expect(recent.getByText('failed').first()).toBeVisible();
    await expect(recent.getByText('timeout').first()).toBeVisible();
    // And the non-claude pipeline tag.
    await expect(recent.getByText('opencode').first()).toBeVisible();
  });

  test('the attempt-history link reaches the canonical task page with the ledger-backed anomaly (#306)', async ({
    page,
  }) => {
    await page.goto('/');

    const duplicateGroup = page.getByTestId(
      `live-run-group-${E2E_ITEM_NUMBERS.ledgerDuplicateDispatch}`,
    );
    await duplicateGroup
      .getByTestId(
        `live-run-group-${E2E_ITEM_NUMBERS.ledgerDuplicateDispatch}-history`,
      )
      .click();

    await expect(page).toHaveURL(
      new RegExp(
        `/task/supersprinklesracing/sprinkles/${E2E_ITEM_NUMBERS.ledgerDuplicateDispatch}$`,
      ),
    );

    const card = page.getByTestId('logical-work-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('logical-work-state')).toHaveText('anomaly');

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
    await expect(
      workspace.getByRole('heading', { name: 'Decision Inbox' }),
    ).toBeVisible();
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

    const filter = workspace.getByRole('button', { name: 'Filter' });
    await filter.focus();
    await page.keyboard.press('Enter');
    const choices = page.getByRole('menuitem');
    await expect(choices).toHaveCount(7);
    await expect(
      page.getByRole('menuitem', { name: 'All reasons' }),
    ).toHaveAttribute('aria-current', 'true');
    await expect(
      page.getByRole('menuitem', { name: 'Ready for agent' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(filter).toBeFocused();
  });

  test('uses a list-to-detail flow on a phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/inbox');

    const workspace = page.getByRole('region', { name: 'Decision Inbox' });
    const header = page.locator('.console-header[data-current="inbox"]');
    await expect(header).toBeVisible();
    await expect(header.getByRole('link', { name: 'Inbox' })).toBeVisible();
    await expectMobileBridgeHeader(header);
    await expect(workspace.locator('.queue-workspace__list')).toBeVisible();
    await expect(workspace.locator('.queue-workspace__detail')).toBeHidden();

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
    await expect(
      workspace.getByRole('link', { name: 'Inbox', exact: true }),
    ).toBeVisible();

    await workspace.getByRole('link', { name: 'Inbox', exact: true }).click();
    await expect(page).not.toHaveURL(/\bitem=/);
    await expect(workspace.locator('.queue-workspace__list')).toBeVisible();
  });

  test('keeps the Bridge compact and navigable on a phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const header = page.locator('.console-header[data-current="deck"]');
    await expect(header).toBeVisible();
    await expect(header.getByRole('link', { name: 'Bridge' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Inbox' })).toBeHidden();
    await expectMobileBridgeHeader(header);
    await expect(
      page.getByRole('region', { name: 'Decision Inbox' }),
    ).toHaveCount(0);
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
        ['deck', '/', 'nav.lcars-nav'],
        ['inbox', '/inbox', 'nav.lcars-nav'],
        ['agents', '/agents', 'nav.lcars-nav'],
        ['sessions', '/sessions', 'nav.lcars-nav'],
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(
      page
        .locator('.console-header[data-current="deck"]')
        .getByRole('link', { name: 'Bridge' }),
    ).toBeVisible();
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
});
