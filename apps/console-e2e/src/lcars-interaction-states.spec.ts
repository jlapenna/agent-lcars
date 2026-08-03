import { expect, Page, test } from '@playwright/test';

import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

/**
 * #42: PR #32's pill nav, the global `:focus-visible` ring, and the
 * `prefers-reduced-motion` guard were written and eyeballed in static
 * screenshots but never actually interacted with — no hover, no press, no
 * Tab, no reduced-motion toggle, and no modal ever opened.
 *
 * These assert the states the CSS claims to have, so a future edit to
 * `.lcars-nav-pill` or the global ring can't silently drop one. What they
 * can't do is judge whether a state *reads* well; that part of #42 is a
 * human's call.
 */

const deckPill = (page: Page) => page.getByRole('link', { name: 'Deck' });
const inboxPill = (page: Page) => page.getByRole('link', { name: 'Inbox' });
const agentsPill = (page: Page) => page.getByRole('link', { name: 'Agents' });

const backgroundOf = (page: Page, name: string) =>
  page
    .getByRole('link', { name })
    .evaluate((el) => getComputedStyle(el).backgroundColor);

useE2eAdminBeforeEach();

test.describe('LCARS pill nav interaction states', () => {
  test('hovering a pill tints it, and leaving restores it', async ({
    page,
  }) => {
    await page.goto('/');
    // Agents, not Deck: the active pill is filled, so it has a non
    // transparent background before any hover and can't show the change.
    const before = await backgroundOf(page, 'Agents');
    await agentsPill(page).hover();
    await expect.poll(() => backgroundOf(page, 'Agents')).not.toBe(before);

    // Move the pointer well clear and confirm it returns — a hover rule
    // that never releases is its own bug.
    await page.mouse.move(0, 0);
    await expect.poll(() => backgroundOf(page, 'Agents')).toBe(before);
  });

  test('pressing a pill scales it down and releases', async ({ page }) => {
    await page.goto('/');
    const pill = agentsPill(page);
    const box = await pill.boundingBox();
    expect(box).not.toBeNull();

    const transform = () =>
      pill.evaluate((el) => getComputedStyle(el).transform);
    expect(await transform()).toBe('none');

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    // matrix(0.96, 0, 0, 0.96, 0, 0) — asserted as "not none" rather than on
    // the exact matrix so tweaking the scale factor doesn't fail this.
    await expect.poll(transform).not.toBe('none');
    await page.mouse.up();
  });

  test('Tab reaches every pill and each shows the focus ring', async ({
    page,
  }) => {
    await page.goto('/');

    const ringOf = (name: string) =>
      page.getByRole('link', { name }).evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          width: style.outlineWidth,
          style: style.outlineStyle,
          color: style.outlineColor,
          offset: style.outlineOffset,
        };
      });

    for (const name of ['Deck', 'Inbox', 'Agents', 'Sessions', 'Costs']) {
      await page.getByRole('link', { name }).focus();
      const ring = await ringOf(name);
      expect(ring.style).toBe('solid');
      expect(ring.width).toBe('2px');
      // Offset, not inset: the ring is drawn clear of the pill's own fill,
      // which is what keeps it legible on the amber-filled active pill —
      // #42's specific worry.
      expect(ring.offset).toBe('2px');
      expect(ring.color).not.toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('keyboard focus actually walks the nav in order', async ({ page }) => {
    await page.goto('/');
    await deckPill(page).focus();
    await page.keyboard.press('Tab');
    await expect(inboxPill(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(agentsPill(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Sessions' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Costs' })).toBeFocused();
  });
});

// The suite-wide default is `reducedMotion: 'reduce'` (playwright.config.ts),
// so the un-suppressed case needs an explicit override to be observable at
// all.
test.describe('pill nav transitions honor prefers-reduced-motion', () => {
  test.describe('with motion allowed', () => {
    // Via `contextOptions`, which is where this knob lives as of Playwright
    // 1.61 (there is no standalone `use.reducedMotion` any more) and where
    // playwright.config.ts sets the suite-wide 'reduce' default.
    test.use({ contextOptions: { reducedMotion: 'no-preference' } });

    test('keeps its real transition duration', async ({ page }) => {
      await page.goto('/');
      const duration = await agentsPill(page).evaluate(
        (el) => getComputedStyle(el).transitionDuration,
      );
      expect(duration).not.toBe('0s');
      expect(parseFloat(duration)).toBeGreaterThan(0.05);
    });
  });

  test.describe('with reduced motion requested', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    test('collapses the transition to effectively zero', async ({ page }) => {
      await page.goto('/');
      const duration = await agentsPill(page).evaluate(
        (el) => getComputedStyle(el).transitionDuration,
      );
      // global.css clamps to 0.01ms rather than 0 (keeping transitionend
      // firing), so this is a threshold, not an equality.
      expect(parseFloat(duration)).toBeLessThan(0.001);
    });
  });
});

test.describe('overlays inherit the LCARS theme', () => {
  test('the Quick Task modal opens, is dismissible, and uses the app fonts', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Quick task' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'File a quick task' }),
    ).toBeVisible();
    // The dispatch button starts disabled until a description is typed —
    // the modal's own contract, worth pinning now that it's actually opened
    // in a browser rather than only in jsdom.
    await expect(
      dialog.getByRole('button', { name: 'File & dispatch' }),
    ).toBeDisabled();

    // Inherited, not defaulted: a modal rendered outside the theme provider
    // would fall back to the browser's own sans-serif.
    const bodyFont = await page.evaluate(
      () => getComputedStyle(document.body).fontFamily,
    );
    const dialogFont = await dialog.evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(dialogFont).toBe(bodyFont);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Quick Task submits one complete repository-explicit issue write', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Quick task' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Description').fill('Verify Quick Task contract');
    await dialog.getByRole('button', { name: 'File & dispatch' }).click();

    // The fixture assigns a real-looking, incrementing issue number rather
    // than a fixed one (agent-lcars#307) - shared server process, so a
    // number depends on how many Quick Tasks earlier specs already filed.
    const receipt = page.getByRole('link', {
      name: /^Quick task filed as supersprinklesracing\/sprinkles#\d+$/,
    });
    await expect(receipt).toBeVisible();
    await expect(receipt).toHaveAttribute(
      'href',
      /^https:\/\/github\.com\/supersprinklesracing\/sprinkles\/issues\/\d+$/,
    );
    await expect(dialog).toBeHidden();
  });
});
