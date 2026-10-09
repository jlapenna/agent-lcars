import { expect, test } from '@playwright/test';
import { encode } from 'next-auth/jwt';

import { resetCliSessions } from './seed';
import { NATIVE_WORK_ID, NATIVE_WORK_TITLE } from './util/native-work';

const OPERATOR = 'e2e-work-operator';

/** Real encrypted Auth.js cookies, with truthful non-admin claims. This
 * fixture never uses the privileged production-verifier minting path. */
async function operatorCookie(login = OPERATOR) {
  const name = 'authjs.session-token';
  return {
    name,
    value: await encode({
      secret: 'dummy-secret',
      salt: name,
      maxAge: 3600,
      token: { sub: login, githubLogin: login, isAdmin: false, name: login },
    }),
    url: 'http://127.0.0.1:4200',
  };
}

test.beforeEach(async ({ request }) => {
  expect(
    (
      await request.post('/api/e2e/work-operator', { data: { revoked: false } })
    ).ok(),
  ).toBe(true);
  await resetCliSessions();
  expect(
    (
      await request.post('/api/e2e/seed', {
        data: { action: 'seed-inbox-only', resume: true },
      })
    ).ok(),
  ).toBe(true);
});

test.afterEach(async ({ request }) => {
  expect(
    (
      await request.post('/api/e2e/work-operator', { data: { revoked: false } })
    ).ok(),
  ).toBe(true);
  await resetCliSessions();
});

test.describe('Work operator access', () => {
  test('lands on Work, navigates to schedules and detail, and has no admin navigation on desktop or mobile', async ({
    page,
  }) => {
    await page.context().addCookies([await operatorCookie()]);
    const publicSession = await page.request.get('/api/auth/session');
    expect((await publicSession.json()).user).toMatchObject({
      login: OPERATOR,
      isAdmin: false,
    });
    expect(await publicSession.text()).not.toContain('githubAccessToken');
    await page.goto('/');
    await expect(page).toHaveURL('/work');
    await expect(
      page.getByRole('heading', { name: 'Work', exact: true }),
    ).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Console sections' });
    await expect(nav.getByRole('link')).toHaveCount(1);
    await expect(
      nav.getByRole('link', { name: 'Work', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Schedules →', exact: true }).click();
    await expect(page).toHaveURL('/work/schedules');
    await expect(
      page.getByRole('heading', { name: 'Schedules', exact: true }),
    ).toBeVisible();
    await page.goto(`/work/${NATIVE_WORK_ID}`);
    await expect(
      page.getByRole('heading', { name: NATIVE_WORK_TITLE, exact: true }),
    ).toBeVisible();
    await expect(page.locator('a[href^="/sessions"]')).toHaveCount(0);
    // Exercise a real grant-authorized Server Action as a non-admin.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Operator edited native work');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Operator edited native work',
        exact: true,
      }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('button', { name: 'More console options' })
      .filter({ visible: true })
      .click();
    await expect(
      page.getByRole('menuitem', { name: 'Work', exact: true }),
    ).toBeVisible();
    for (const name of [
      'Bridge',
      'Inbox',
      'Agents',
      'Shuttlebay',
      'Sessions',
      'Costs',
    ]) {
      await expect(
        page.getByRole('menuitem', { name, exact: true }),
      ).toHaveCount(0);
    }
  });

  test('denies direct admin pages and APIs to an operator', async ({
    page,
  }) => {
    await page.context().addCookies([await operatorCookie()]);
    for (const path of [
      '/inbox',
      '/agents',
      '/shuttlebay',
      '/sessions',
      '/costs',
      '/sessions/unknown',
      '/task/owner/repo/1',
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL('/work');
      await expect(
        page.getByRole('heading', { name: 'Work', exact: true }),
      ).toBeVisible();
    }
    for (const path of [
      '/api/dashboard/stream',
      '/api/runner-status',
      '/api/runner-status/stream',
    ]) {
      expect((await page.request.get(path)).status()).toBe(401);
    }
  });

  test('denies an ungranted login and revokes the next operation without replacing the session', async ({
    page,
    request,
  }) => {
    await page.context().addCookies([await operatorCookie('e2e-no-grant')]);
    await page.goto('/login');
    await expect(page.getByTestId('login-unauthorized')).toBeVisible();
    expect((await page.request.get('/api/work/v1/items')).status()).toBe(401);
    await page.context().addCookies([await operatorCookie()]);
    await page.goto(`/work/${NATIVE_WORK_ID}`);
    await expect(
      page.getByRole('heading', { name: NATIVE_WORK_TITLE, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Title', exact: true })
      .fill('Must not persist after revocation');
    expect(
      (
        await request.post('/api/e2e/work-operator', {
          data: { revoked: true },
        })
      ).ok(),
    ).toBe(true);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByText('work.operator scope required', { exact: true }),
    ).toBeVisible();
    expect((await page.request.get('/api/work/v1/items')).status()).toBe(401);
    await page.goto('/work');
    await expect(
      page.getByText('Your GitHub login has no work grant.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'New work' })).toHaveCount(0);
    await page.goto('/work/schedules');
    await expect(
      page.getByText('Your GitHub login has no work grant.', { exact: true }),
    ).toBeVisible();
    await page.goto('/login');
    await expect(page.getByTestId('login-unauthorized')).toBeVisible();
    const unchanged = await request.get(
      `/api/work/v1/items/${NATIVE_WORK_ID}`,
      {
        headers: { 'X-e2e-auth-user': 'e2e-agent-lcars-admin' },
      },
    );
    expect(unchanged.ok()).toBe(true);
    expect((await unchanged.json()).spec.title).toBe(NATIVE_WORK_TITLE);
  });

  test('preserves full navigation and admin API access for the explicit admin fixture', async ({
    page,
  }) => {
    await page.context().setExtraHTTPHeaders({
      'X-e2e-auth-user': 'e2e-agent-lcars-admin',
    });
    await page.goto('/work');
    await expect(
      page
        .getByRole('navigation', { name: 'Console sections' })
        .getByRole('link'),
    ).toHaveCount(7);
    expect((await page.request.get('/api/runner-status')).status()).toBe(200);
    await page.goto('/login');
    await expect(page).toHaveURL('/');
  });
});
