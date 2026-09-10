import { expect, type Page, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import { setE2eAdminUser } from './util/e2e-test-utils';

/**
 * Every visible text node must clear WCAG AA against the background actually
 * composited behind it.
 *
 * This is an e2e assertion because contrast is a property of the *rendered*
 * page, not of the stylesheet: a token can be correct and still lose to a
 * runtime-injected variable (#1836, #1843), and a colour can be legible on one
 * route's ground and illegible on another's tinted panel.
 *
 * It is also not judgeable by eye, which is why it went unnoticed for so long.
 * Before #1847 light mode failed on 373 nodes and nothing about the page
 * looked wrong — #f4f4f6 beside #eeeff2 reads as one colour, and a
 * browser-default link looks like a link.
 *
 * Two traps are handled in `contrastFailures` below and are the reason the
 * first two versions of this measurement reported numbers that were simply
 * false. Both are documented in docs/console-design-system.md.
 */

const ROUTES = [
  { name: 'Bridge', path: '/' },
  { name: 'Inbox', path: '/inbox' },
  { name: 'Agents', path: '/agents' },
  { name: 'Costs', path: '/costs' },
] as const;

const SCHEMES = ['dark', 'light'] as const;

interface Failure {
  text: string;
  ratio: number;
  required: number;
  fontSize: number;
  foreground: string;
  background: string;
  selector: string;
}

async function contrastFailures(page: Page): Promise<Failure[]> {
  return page.evaluate(() => {
    // Computed colours arrive in two serialisations: `rgb(r g b)` on 0-255,
    // and `color(srgb r g b)` on 0-1 whenever the value came from
    // `color-mix()`. Reading the second as 0-255 makes every tinted surface
    // look near-black and manufactures failures.
    const parse = (value: string): number[] => {
      const parts = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      if (parts.length < 3) return [0, 0, 0];
      return /^color\(/.test(value)
        ? parts.map((channel) => Math.round(channel * 255))
        : parts;
    };
    const alphaOf = (value: string): number => {
      const parts = value.match(/[\d.]+/g) ?? [];
      return parts.length > 3 ? Number(parts[3]) : 1;
    };
    const over = (fg: number[], alpha: number, bg: number[]): number[] =>
      fg.map((channel, i) => Math.round(channel * alpha + bg[i] * (1 - alpha)));

    // Composite every translucent layer down to an opaque colour. A
    // blockquote tinted `rgba(96,112,138,0.07)` is 7% grey over what is under
    // it; treating any non-zero alpha as opaque compares text against solid
    // grey-6 and invents failures.
    const backgroundBehind = (element: Element): number[] => {
      const layers: Array<[number[], number]> = [];
      let node: Element | null = element;
      while (node && node !== document.documentElement) {
        const colour = getComputedStyle(node).backgroundColor;
        const alpha = colour ? alphaOf(colour) : 0;
        if (colour && alpha > 0) {
          if (alpha >= 0.999) {
            return layers.reduceRight(
              (bg, [fg, a]) => over(fg, a, bg),
              parse(colour),
            );
          }
          layers.push([parse(colour), alpha]);
        }
        node = node.parentElement;
      }
      return layers.reduceRight(
        (bg, [fg, a]) => over(fg, a, bg),
        parse(getComputedStyle(document.body).backgroundColor),
      );
    };

    const luminance = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratioOf = (a: number[], b: number[]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const failures = [];
    for (const element of document.querySelectorAll('*')) {
      const text = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? '')
        .join(' ')
        .trim();
      if (text.length < 2) continue;

      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (Number.parseFloat(style.opacity) < 0.5) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) continue;

      const fontSize = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      // WCAG "large text": >= 24px, or >= 18.66px bold.
      const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      const ratio = ratioOf(parse(style.color), backgroundBehind(element));

      if (ratio < required) {
        failures.push({
          text: text.slice(0, 40),
          ratio: Number(ratio.toFixed(2)),
          required,
          fontSize: Math.round(fontSize),
          foreground: style.color,
          background: `rgb(${backgroundBehind(element).join(', ')})`,
          selector: element.className.toString().slice(0, 40),
        });
      }
    }
    return failures;
  });
}

usePopulatedFixtures();

test.describe('text contrast @design-system', () => {
  for (const scheme of SCHEMES) {
    for (const route of ROUTES) {
      test(`${route.name} clears WCAG AA in ${scheme} mode`, async ({
        page,
      }) => {
        await setE2eAdminUser(page);
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

        // The scheme this case claims to test is the scheme it is in. Without
        // this a mis-scoped cookie makes every "light" case a second
        // dark-mode run that passes for the wrong reason.
        await expect(page.locator('html')).toHaveAttribute(
          'data-mantine-color-scheme',
          scheme,
        );

        // Poll rather than sample once. A scheme flip repaints regions
        // independently, so a single read can catch the page mid-transition
        // with the previous scheme's ink over the new scheme's ground - a
        // real state, but not the one under test, and one that reports
        // spectacular ratios like 1.05:1. If the failures never clear this
        // still fails, and prints exactly what did not.
        await expect
          .poll(
            async () => {
              const failures = await contrastFailures(page);
              return failures.length === 0
                ? 'all text clears AA'
                : failures
                    .map(
                      (f) =>
                        `${f.ratio}:1 (needs ${f.required}) ${f.fontSize}px ` +
                        `${f.foreground} on ${f.background} — "${f.text}" .${f.selector}`,
                    )
                    .join('\n');
            },
            { message: 'text contrast never settled' },
          )
          .toBe('all text clears AA');
      });
    }
  }
});
