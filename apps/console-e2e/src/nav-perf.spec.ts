import { expect, type Page, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import { E2E_ADMIN_HEADERS } from './util/e2e-test-utils';

/**
 * Client-side rail navigation keeps the live frame and swaps the page once.
 *
 * Asserts the deterministic part: no navigation replaces the rail or commits
 * a page skeleton (a committed fallback also delays the content behind
 * React's 300 ms reveal throttle). Timing is printed, never asserted: one
 * `NAVPERF {...}` JSON line with the median and p90 click-to-ready time.
 * `E2E_GREP=@navperf tools/e2e-local.sh` runs five measured rounds instead
 * of one.
 *
 * Ready = the URL reached the destination, the active pill is the target,
 * and no streaming fallback or loading status remains on screen.
 */
const LOOP = ['Work', 'Inbox', 'Sessions', 'Agents', 'Costs', 'Bridge'];
const ROUNDS = process.env['E2E_GREP']?.includes('navperf') ? 5 : 1;
const PATHS: Record<string, string> = {
  Bridge: '/',
  Inbox: '/inbox',
  Agents: '/agents',
  Work: '/work',
  Sessions: '/sessions',
  Costs: '/costs',
};

usePopulatedFixtures();

async function waitReady(page: Page, label: string) {
  const path = PATHS[label];
  await page.waitForFunction(
    ({ path, label }) => {
      if (location.pathname !== path) return false;
      const active = document.querySelector(
        'nav[aria-label="Console sections"] [aria-current="page"]',
      );
      if (!active || !active.textContent?.includes(label)) return false;
      if (document.querySelector('[data-streaming-fallback]')) return false;
      if (document.querySelector('[role="status"][aria-label="Loading"]'))
        return false;
      return true;
    },
    { path, label },
    { polling: 'raf', timeout: 30_000 },
  );
}

test('@navperf rail navigation keeps the frame and skips skeletons', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders(E2E_ADMIN_HEADERS);
  await page.goto('/');
  await waitReady(page, 'Bridge');
  // Warm every route once so the measurement is steady-state navigation,
  // not first-compile or cold-cache cost.
  for (const label of LOOP) {
    await page
      .getByRole('navigation', { name: 'Console sections' })
      .first()
      .getByRole('link', { name: label, exact: false })
      .first()
      .click();
    await waitReady(page, label);
  }

  await page.evaluate(() => {
    const w = window as unknown as { __skeletons?: number };
    w.__skeletons = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches('[role="status"][aria-label="Loading"]') ||
              node.querySelector('[role="status"][aria-label="Loading"]'))
          ) {
            w.__skeletons = (w.__skeletons ?? 0) + 1;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  const samples: number[] = [];
  const perRoute: Record<string, number[]> = {};
  let chromeRemounts = 0;
  for (let round = 0; round < ROUNDS; round++) {
    for (const label of LOOP) {
      await page.evaluate(() => {
        const w = window as unknown as { __railHome?: Element | null };
        w.__railHome = document.querySelector('[data-testid="rail-home"]');
      });
      const link = page
        .getByRole('navigation', { name: 'Console sections' })
        .first()
        .getByRole('link', { name: label, exact: false })
        .first();
      await link.waitFor();
      const start = await page.evaluate(() => performance.now());
      await link.click();
      await waitReady(page, label);
      const end = await page.evaluate(() => performance.now());
      samples.push(end - start);
      (perRoute[label] ??= []).push(end - start);
      const kept = await page.evaluate(() => {
        const w = window as unknown as { __railHome?: Element | null };
        return Boolean(w.__railHome && w.__railHome.isConnected);
      });
      chromeRemounts += Number(!kept);
    }
  }
  const skeletons = await page.evaluate(
    () => (window as unknown as { __skeletons?: number }).__skeletons ?? 0,
  );
  samples.sort((a, b) => a - b);
  const pct = (p: number) =>
    samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `NAVPERF ${JSON.stringify({
      median: Math.round(pct(0.5)),
      p90: Math.round(pct(0.9)),
      mean: Math.round(mean),
      n: samples.length,
      chromeRemounts,
      skeletons,
      perRoute: Object.fromEntries(
        Object.entries(perRoute).map(([k, v]) => [
          k,
          Math.round([...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]),
        ]),
      ),
    })}`,
  );
  expect(chromeRemounts).toBe(0);
  expect(skeletons).toBe(0);
});

/**
 * A hard load streams each page's content in exactly once. If hydration
 * client-renders a boundary whose streamed HTML is still pending, the same
 * panel is briefly live and also parked in React's hidden `S:` segment, which
 * breaks every strict locator on the page. CPU throttling widens that window.
 */
test('@navperf hard loads never show streamed content twice', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setExtraHTTPHeaders(E2E_ADMIN_HEADERS);
  await page.addInitScript(() => {
    const w = window as unknown as { __doubled: string[] };
    w.__doubled = [];
    const headings = (root: ParentNode) =>
      [...root.querySelectorAll('h1, h2')].map((h) => h.textContent ?? '');
    new MutationObserver(() => {
      for (const segment of document.querySelectorAll(
        'div[hidden][id^="S:"]',
      )) {
        const live = new Set(
          [...document.querySelectorAll('h1, h2')]
            // A page fallback repeats the title by design; only real
            // content counts.
            .filter(
              (h) =>
                !h.closest('div[hidden]') &&
                !h.closest('[data-streaming-fallback]'),
            )
            .map((h) => h.textContent ?? ''),
        );
        for (const text of headings(segment)) {
          if (text && live.has(text)) w.__doubled.push(`${segment.id}:${text}`);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const doubled: string[] = [];
  for (const label of LOOP) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(PATHS[label]);
      await waitReady(page, label);
      doubled.push(
        ...(await page.evaluate(
          () => (window as unknown as { __doubled: string[] }).__doubled,
        )),
      );
    }
  }
  expect([...new Set(doubled)]).toEqual([]);
});
