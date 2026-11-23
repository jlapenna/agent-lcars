import { type Page, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import { E2E_ADMIN_HEADERS } from './util/e2e-test-utils';

/**
 * Client-side navigation benchmark (@navperf). Not part of the default
 * suite's assertions: it clicks a fixed loop of rail destinations and prints
 * one `NAVPERF {...}` JSON line with the median and p90 click-to-ready time,
 * plus how often the persistent chrome (rail home link) was replaced.
 *
 * Ready = the URL reached the destination, the active pill is the target,
 * and no streaming fallback or loading status remains on screen.
 */
const LOOP = ['Work', 'Inbox', 'Sessions', 'Agents', 'Costs', 'Bridge'];
const ROUNDS = 5;
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

test('@navperf rail navigation latency', async ({ page }) => {
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

  const samples: number[] = [];
  const perRoute: Record<string, number[]> = {};
  const rscBytes: number[] = [];
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
      let bytes = 0;
      const onResponse = async (r: import('@playwright/test').Response) => {
        if (r.request().headers()['rsc'] === '1') {
          try {
            bytes += (await r.body()).length;
          } catch {
            /* navigation may discard the body */
          }
        }
      };
      page.on('response', onResponse);
      const start = await page.evaluate(() => performance.now());
      await link.click();
      await waitReady(page, label);
      const end = await page.evaluate(() => performance.now());
      samples.push(end - start);
      (perRoute[label] ??= []).push(end - start);
      page.off('response', onResponse);
      rscBytes.push(bytes);
      const kept = await page.evaluate(() => {
        const w = window as unknown as { __railHome?: Element | null };
        return Boolean(w.__railHome && w.__railHome.isConnected);
      });
      if (!kept) chromeRemounts++;
    }
  }
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
      rscKb: Math.round(
        rscBytes.reduce((a, b) => a + b, 0) / rscBytes.length / 1024,
      ),
      perRoute: Object.fromEntries(
        Object.entries(perRoute).map(([k, v]) => [
          k,
          Math.round([...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]),
        ]),
      ),
    })}`,
  );
});
