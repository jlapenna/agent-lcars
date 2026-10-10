import { expect, type Route, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();

test.describe('/shuttlebay workspace', () => {
  test('keeps live runner status on its own top-level page', async ({
    page,
  }) => {
    await page.goto('/shuttlebay');

    await expect(page.getByRole('heading', { name: 'Shuttlebay' })).toHaveCount(
      1,
    );
    await expect(
      page.getByText('Updates live as runner capacity changes.'),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Console sections' })
        .getByRole('link', { name: 'Shuttlebay' }),
    ).toHaveAttribute('aria-current', 'page');
    // Shuttlebay used to be the one destination with no create button,
    // not by design: a `.lcars-command-utilities:has(...)` rule matched the
    // shared cluster instead of the mobile wrapper inside it and hid the
    // whole thing from 64em up (#1810).
    await expect(page.getByRole('button', { name: 'New work' })).toHaveCount(1);
  });

  test('keeps every console destination reachable on a narrow phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/shuttlebay');

    const header = page.locator(
      '.console-header[data-current="shuttlebay"]:not([data-streaming-fallback])',
    );
    await expect(header.getByRole('link', { name: 'Shuttlebay' })).toBeHidden();
    await expect(
      header.getByRole('heading', { name: 'Shuttlebay' }),
    ).toBeVisible();
    await expect(
      header.getByRole('button', { name: 'New work' }),
    ).toBeVisible();
    await expect(header.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Bridge' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Inbox' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Agents' })).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: 'Sessions' }),
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Costs' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test('keeps the overflow menu available on a tablet command rail', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 1024 });
    await page.goto('/shuttlebay');

    const header = page.locator(
      '.console-header[data-current="shuttlebay"]:not([data-streaming-fallback])',
    );
    await expect(
      header.getByRole('link', { name: 'Shuttlebay' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'More console options' }).click();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Sessions' }),
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Costs' })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});

// Use real browser EventSource parsing/reconnection, with controlled HTTP
// boundaries. No fake EventSource or dependency on producer heartbeat timing.
test.describe('Shuttlebay live stream', () => {
  usePopulatedFixtures();

  test('shows cooldown/reset provenance, normal claims, drain and unavailable provider evidence', async ({
    page,
  }) => {
    const connections: Array<Promise<Route>> = [];
    const accept: Array<(route: Route) => void> = [];
    for (let i = 0; i < 4; i++)
      connections.push(new Promise((resolve) => accept.push(resolve)));
    let index = 0;
    await page.route('**/api/runner-status/stream', async (route) => {
      const resolve = accept[index++];
      if (resolve) resolve(route);
      else await route.abort();
    });
    await page.goto('/shuttlebay');
    const now = new Date().toISOString();
    const reset = new Date(Date.now() + 60_000).toISOString();
    const provider = {
      pipeline: 'claude',
      queued: 2,
      deferred: 0,
      liveClaims: 0,
      eligible: 0,
      cooldown: {
        pipeline: 'claude',
        runId: 'quota/r1',
        observedAt: now,
        expiresAt: reset,
      },
    };
    const executor = {
      schemaVersion: 2,
      kind: 'queue-executor',
      executor: 'queue',
      ready: true,
      draining: false,
      activeRuns: 0,
      maxConcurrent: 3,
      updatedAt: now,
      claims: {
        claude: 3,
        codex: 0,
        opencode: 1,
        windowStart: new Date(Date.now() - 60_000).toISOString(),
        windowEnd: now,
      },
    };
    const snapshot = {
      warnings: [],
      queueExecutor: executor,
      providerAdmission: {
        observedAt: now,
        provenance: 'orchestrator',
        providers: [provider],
      },
    };
    const send = async (connection: number, data: unknown) =>
      (await connections[connection]).fulfill({
        contentType: 'text/event-stream',
        body: `retry: 1000\n\nevent: runner-status\ndata: ${JSON.stringify(data)}\n\n`,
      });
    await send(0, snapshot);
    const row = page.getByTestId('provider-admission-claude');
    await expect(row).toContainText('cooling down');
    await expect(row).toContainText(reset);
    await expect(row).toContainText('quota/r1');
    await expect(row).toContainText('3 claims from');
    const healthy = {
      ...snapshot,
      providerAdmission: {
        ...snapshot.providerAdmission,
        providers: [{ ...provider, eligible: 2, cooldown: undefined }],
      },
    };
    await send(1, healthy);
    await expect(row).toContainText('2 eligible queued');
    await expect(row).toContainText('no active cooldown');
    await send(2, {
      ...healthy,
      queueExecutor: { ...executor, draining: true },
    });
    await expect(row).toContainText('executor draining');
    await expect(row).toContainText('0 eligible queued');
    await expect(row).toContainText('2 queued');
    await send(3, {
      warnings: ['Provider queue and cooldown status unavailable.'],
    });
    await expect(row).toContainText('admission unavailable');
    await expect(row).toContainText('Eligible queue unavailable');
    await expect(row).toContainText('Recent claims unavailable');
    await expect(row).not.toContainText('0 eligible queued');
  });

  test('renders the initial snapshot, updates, expires while denied, and recovers after reconnect', async ({
    page,
  }) => {
    const pending: Array<Promise<Route>> = [];
    const accept: Array<(route: Route) => void> = [];
    for (let i = 0; i < 3; i++) {
      pending.push(new Promise<Route>((resolve) => accept.push(resolve)));
    }
    let connections = 0;
    await page.route('**/api/runner-status/stream', async (route) => {
      const resolve = accept[connections++];
      if (resolve) resolve(route);
      else await route.abort();
    });
    await page.clock.install();
    await page.goto('/shuttlebay');
    const fleet = page.getByTestId('arc-lane-e2e-fixture-runners');
    await expect(fleet).toContainText(
      '1 running · 1 idle · 2 registered · 2 desired · 2 max',
    );

    const snapshot = (activeRuns: number, updatedAt: string) => ({
      lanes: [],
      warnings: [],
      queueExecutor: {
        schemaVersion: 2,
        kind: 'queue-executor',
        executor: 'queue',
        ready: true,
        draining: false,
        activeRuns,
        maxConcurrent: 4,
        updatedAt,
      },
    });
    const send = async (route: Route, activeRuns: number) => {
      const updatedAt = await page.evaluate(() => new Date().toISOString());
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `retry: 1000\n\nevent: runner-status\ndata: ${JSON.stringify(snapshot(activeRuns, updatedAt))}\n\n`,
      });
    };
    await send(await pending[0], 2);
    const executor = page.getByTestId('queue-executor-status');
    await expect(executor).toContainText('2 active · 4 max');
    await expect(fleet).toHaveCount(0);

    // EOF above makes the browser reconnect. Serve the actual route's auth
    // refusal to that connection (the document remains authenticated).
    const denied = await pending[1];
    const response = await denied.fetch({
      headers: { ...denied.request().headers(), 'X-e2e-auth-user': 'unauthed' },
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    const refusal = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/runner-status/stream') &&
        response.status() === 401,
    );
    await denied.fulfill({ response });
    await refusal;
    await expect(executor).toContainText('2 active · 4 max');

    // A stopped stream cannot leave capacity looking live forever. Advance
    // only the browser clock beyond the three-heartbeat expiry; no sleep.
    const recovery = await pending[2];
    await page.clock.fastForward(190_000);
    const warnings = page.getByTestId('data-warnings');
    await expect(warnings).toBeVisible();
    await warnings.locator('summary').click();
    await expect(
      page.getByText('Runner capacity status is stale.'),
    ).toBeVisible();
    await expect(executor).toHaveCount(0);

    // HTTP denial closes EventSource permanently; the application's bounded
    // retry must open a new one and replace the stale view with fresh data.
    await send(recovery, 3);
    await expect(executor).toContainText('3 active · 4 max');
    await expect(executor.getByText('ready', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Runner capacity status is stale.'),
    ).toHaveCount(0);
  });
});
