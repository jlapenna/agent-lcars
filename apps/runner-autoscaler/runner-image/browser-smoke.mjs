import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Resolve the image-owned package, independently of a mounted repository.
const { chromium } = createRequire('/opt/playwright/package.json')(
  'playwright',
);

assert.notEqual(process.getuid(), 0, 'Browser proof must run as the job user');
const browser = await chromium.launch(
  process.env.LCARS_BROWSER_SMOKE_EMULATED ? { args: ['--no-zygote'] } : {},
);
try {
  const page = await browser.newPage();
  await page.setContent(
    '<button onclick="this.textContent = \'Measured\'">Measure</button>',
  );
  await page.getByRole('button', { name: 'Measure', exact: true }).click();
  assert.equal(await page.getByRole('button').textContent(), 'Measured');
  assert.equal(
    await page.evaluate(() => typeof PerformanceObserver),
    'function',
  );
  console.log(
    `Chromium ${browser.version()}: render, interaction and performance API ready`,
  );
} finally {
  await browser.close();
}
