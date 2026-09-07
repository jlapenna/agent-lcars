import { expect, type Page, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import { setE2eAdminUser } from './util/e2e-test-utils';

/**
 * The console's first design rule: it has exactly ONE ground. Header, page,
 * workspace, card and panel all paint `--lcars-surface`; separation between
 * regions comes from a hairline, a gutter or an accent bar, never from a
 * second, slightly different shade.
 *
 * This has to be an e2e assertion rather than a rule in
 * `design-system-contract.test.ts`, because the ways it breaks are not
 * visible in the stylesheet:
 *
 *   - #1825: `global.css` re-anchored Mantine's scheme variables at a
 *     specificity Mantine's own declarations beat, so the whole block
 *     silently did nothing and the page sat on dark-7 while the shells sat
 *     on dark-9.
 *   - #1836: MantineProvider injects a runtime <style> derived from
 *     `theme.white` that sets `--mantine-color-body` for the LIGHT scheme
 *     only, after every static stylesheet - so light mode ignored this file
 *     no matter what it said.
 *
 * Both are invisible in source and nearly invisible on screen (#f4f4f6 next
 * to #eeeff2). Only the computed value tells the truth, which is what this
 * reads.
 */

const ROUTES = [
  { name: 'Bridge', path: '/' },
  { name: 'Inbox', path: '/inbox' },
  { name: 'Agents', path: '/agents' },
  { name: 'Shuttlebay', path: '/shuttlebay' },
  { name: 'Work', path: '/work' },
  { name: 'Sessions', path: '/sessions' },
  { name: 'Costs', path: '/costs' },
] as const;

const SCHEMES = ['dark', 'light'] as const;

/** Every opaque background among the console's structural surfaces. */
async function structuralSurfaces(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const surfaces: Record<string, string> = {};
    const opaque = (color: string) =>
      Boolean(color) && color !== 'rgba(0, 0, 0, 0)' && !/, 0\)$/.test(color);

    const record = (key: string, element: Element | null) => {
      if (!element) return;
      const color = getComputedStyle(element).backgroundColor;
      if (opaque(color)) surfaces[key] = color;
    };

    record('body', document.body);
    record('shell', document.querySelector('.console-page-shell'));
    record('header', document.querySelector('.console-header[data-current]'));
    record('workspace', document.querySelector('.console-workspace'));
    // A few panels deliberately carry an accent tint and are NOT structural
    // surfaces: the Agents panels say "active"/"claimed"/"recent" that way
    // (hence the `--` modifier filter), and the Bridge's Inbox signpost wears
    // the Inbox accent to say it speaks for another destination. Everything
    // else is the plain ground.
    record(
      'panel',
      document.querySelector(
        '.lcars-panel:not([class*="--"]):not(.deck-inbox-summary)',
      ),
    );

    return surfaces;
  });
}

usePopulatedFixtures();

test.describe('one ground @design-system', () => {
  for (const scheme of SCHEMES) {
    for (const route of ROUTES) {
      test(`${route.name} paints one ground in ${scheme} mode`, async ({
        page,
      }) => {
        await setE2eAdminUser(page);
        // Navigate first so the cookie can be scoped to the real origin -
        // guessing it produced a cookie that never applied, which silently
        // ran both halves of this matrix in dark mode. The scheme assertion
        // below is what makes that unfakeable.
        await page.goto(route.path);
        await page.context().addCookies([
          {
            name: 'mantine-color-scheme',
            value: scheme,
            url: new URL(page.url()).origin,
          },
        ]);
        await page.emulateMedia({ colorScheme: scheme });
        await page.reload();

        // The console really is in the scheme this case claims to test.
        // Mantine ignores `prefers-color-scheme` once the attribute is set,
        // so without this a mis-scoped cookie makes every "light" case a
        // second dark-mode run that passes for the wrong reason.
        await expect(page.locator('html')).toHaveAttribute(
          'data-mantine-color-scheme',
          scheme,
        );

        // Poll rather than sample once. A scheme flip repaints the regions
        // independently, so a single read can catch the page mid-transition
        // with the body still on the old ground and the header on the new
        // one - which is a real state, just not the one under test. If they
        // never converge this still fails, and reports what disagreed.
        // Resolves to 'one ground' once they agree, and otherwise to the
        // surfaces themselves - so a genuine failure reports what disagreed
        // instead of a bare count.
        await expect
          .poll(
            async () => {
              const surfaces = await structuralSurfaces(page);
              // Sanity: the selectors still match something, or this would
              // pass by finding nothing.
              if (Object.keys(surfaces).length < 2) return 'no surfaces found';
              return new Set(Object.values(surfaces)).size === 1
                ? 'one ground'
                : JSON.stringify(surfaces);
            },
            { message: 'structural surfaces never settled on one ground' },
          )
          .toBe('one ground');
      });
    }
  }
});
