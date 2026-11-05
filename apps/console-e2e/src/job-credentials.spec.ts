import { expect, test } from '@playwright/test';

import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();

test('admin uploads and promotes a version without displaying stored values', async ({
  page,
}) => {
  let promotedVersion: string | undefined;
  let releaseUpload!: () => void;
  const uploadRelease = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  const calls: { path: string; body: unknown }[] = [];
  await page.route('**/api/work/v1/credentials/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      calls.push({ path, body: request.postDataJSON() });
      if (path.endsWith('/versions')) {
        await uploadRelease;
        return route.fulfill({ json: { version: '2' } });
      }
      if (path.endsWith('/promote'))
        promotedVersion = request.postDataJSON().version;
      return route.fulfill({ json: {} });
    }
    return route.fulfill({
      json: path.endsWith('/secrets')
        ? [
            {
              name: 'example-key',
              kind: 'opaque',
              enabled: true,
              promotedVersion,
              updatedAt: '2026-11-04T00:00:00Z',
              updatedBy: 'user:jlapenna',
            },
          ]
        : [],
    });
  });
  await page.goto('/jobs/credentials');
  await expect(
    page.getByRole('heading', { name: 'Job credentials', exact: true }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Registered secret' }).click();
  await page.getByRole('option', { name: 'example-key', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'New secret value' })
    .fill('fixture-private-api-key');
  await page
    .getByRole('button', { name: 'Upload version', exact: true })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Registered secret' }),
  ).toBeDisabled();
  releaseUpload();
  await expect(
    page.getByRole('textbox', { name: 'New secret value' }),
  ).toHaveValue('');
  await expect(
    page.getByRole('textbox', { name: 'Version to promote' }),
  ).toHaveValue('2');
  await page
    .getByRole('button', { name: 'Promote version', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Version promoted');
  await expect(page.getByRole('table').first()).toContainText('2');
  await expect(
    page.getByText('fixture-private-api-key', { exact: true }),
  ).toHaveCount(0);
  expect(calls).toEqual([
    {
      path: '/api/work/v1/credentials/secrets/example-key/versions',
      body: { value: 'fixture-private-api-key' },
    },
    {
      path: '/api/work/v1/credentials/secrets/example-key/promote',
      body: { version: '2' },
    },
  ]);
});
