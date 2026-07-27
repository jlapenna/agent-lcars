import { expect, Page, test } from '@playwright/test';

import {
  E2E_ISSUE_AGENT_SESSION_ID,
  E2E_ITEM_NUMBERS,
  usePopulatedFixtures,
} from './seed';
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
  test('renders every action-type badge against real items', async ({
    page,
  }) => {
    await page.goto('/');

    // One per ACTION_COLORS entry — the whole point of the fixture set.
    // `Awaiting next deploy` needs an item carrying a second action type
    // (#9010): a deploy-wait-only item drops to the compact tier below,
    // which renders no action-type badge at all.
    for (const label of [
      'Needs a human',
      'CI run failed',
      'Review requested',
      'Silent error',
      'Awaiting next deploy',
    ]) {
      await expect(page.getByText(label).first()).toBeVisible();
    }

    // And the compact tier itself, which is where a deploy-wait-only item
    // (#9004) goes instead.
    await expect(
      page.getByRole('heading', { name: /Waiting on Next Deploy/ }),
    ).toBeVisible();

    // The silent-error tier only exists because a run's joined session doc
    // contradicts its green conclusion — assert the diagnosis text, not just
    // the badge, since that join is the fragile half.
    await expect(page.getByTestId('silent-error-diagnosis')).toBeVisible();
  });

  test('surfaces per-item detail that only appears on populated cards', async ({
    page,
  }) => {
    await page.goto('/');

    // `.first()`: the same title also appears on this item's run row in the
    // In Flight panel, which is itself the join working.
    await expect(
      page
        .getByRole('link', {
          name: `#${E2E_ITEM_NUMBERS.humanNeeded} Decide the retention window`,
        })
        .first(),
    ).toBeVisible();
    // Failing-check list (run-failed) and the mergeable-state warning
    // (review-requested, `behind`) are both card states no screenshot has
    // ever shown.
    await expect(page.getByText(/^Failed: /).first()).toBeVisible();
    await expect(page.getByText(/Base branch has moved/).first()).toBeVisible();
    // The takeover command the fleet posts on a claimed item.
    await expect(
      page.getByText(/claude-agent-session\.sh resume/).first(),
    ).toBeVisible();
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
    await expect(header.getByText('Tokens')).toBeVisible();
    await expect(header.getByText('Cost')).toBeVisible();
    await expect(
      header.getByRole('link', { name: `#${E2E_ITEM_NUMBERS.silentError}` }),
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
        ['queue', '/', 'nav.lcars-nav'],
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
});
