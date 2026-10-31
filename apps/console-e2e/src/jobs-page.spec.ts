import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { parse } from 'yaml';

import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

useE2eAdminBeforeEach();

function catalog() {
  const directory = path.join(
    process.cwd(),
    '.lcars/jobs/frontend-performance-quality',
  );
  const definition = {
    repository: 'jlapenna/agent-lcars',
    name: 'frontend-performance-quality',
    revision: 'a'.repeat(40),
    digest: 'b'.repeat(64),
    job: parse(fs.readFileSync(path.join(directory, 'job.yaml'), 'utf8')),
    recipeText: fs.readFileSync(path.join(directory, 'recipe.yaml'), 'utf8'),
    parameters: [
      {
        key: 'target',
        description: 'Frontend to inspect',
        requirement: 'required',
        input_type: 'string',
      },
    ],
  };
  return [
    {
      id: '1'.repeat(64),
      repository: definition.repository,
      name: definition.name,
      enabled: false,
      refreshedAt: '2026-10-31T14:00:00Z',
      definition,
    },
    {
      id: '2'.repeat(64),
      repository: 'supersprinklesracing/sprinkles',
      name: definition.name,
      enabled: true,
      refreshedAt: '2026-10-31T14:00:00Z',
      definition: {
        ...definition,
        repository: 'supersprinklesracing/sprinkles',
      },
    },
    {
      id: '3'.repeat(64),
      repository: 'jlapenna/jclaw',
      name: 'weekly-security-audit',
      enabled: false,
      refreshedAt: '2026-10-31T14:00:00Z',
      error: 'Source refresh failed',
    },
  ];
}

test('browse all registrations and review the exact definition before enabling and running', async ({
  page,
}) => {
  const jobs = catalog();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let failRun = true;
  await page.route('**/api/work/v1/jobs**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: jobs });
    const pathname = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    calls.push({ path: pathname, body });
    if (pathname.endsWith('/enable')) {
      jobs[0].enabled = body.enabled;
      return route.fulfill({ json: jobs[0] });
    }
    if (failRun) {
      failRun = false;
      return route.fulfill({
        status: 503,
        json: { error: 'Admission temporarily unavailable' },
      });
    }
    return route.fulfill({
      json: {
        id: '4'.repeat(64),
        jobId: jobs[0].id,
        workId: '01JOBSREQUEST',
        createdAt: '2026-10-31T15:00:00Z',
        trigger: 'manual',
        skipped: false,
      },
    });
  });
  await page.goto('/jobs');
  await expect(page.getByText('3 registered', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Weekly security audit/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Weekly security audit/ }).click();
  await expect(
    page.getByText('Source refresh failed', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: /Frontend performance quality.*jlapenna\/agent-lcars/,
    })
    .click();
  await page.getByRole('button', { name: 'Review to enable' }).click();
  const enable = page.getByRole('button', {
    name: 'Enable reviewed definition',
  });
  await expect(enable).toBeDisabled();
  await page
    .getByRole('checkbox', { name: 'I reviewed this definition and recipe' })
    .check();
  // Refresh installs a different digest; prior review must no longer authorize it.
  jobs[0].definition!.digest = 'c'.repeat(64);
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
  await page.getByRole('button', { name: 'Review to enable' }).click();
  await expect(enable).toBeDisabled();
  await page
    .getByRole('checkbox', { name: 'I reviewed this definition and recipe' })
    .check();
  await enable.click();
  await expect(page.getByText('Reviewed definition enabled.')).toBeVisible();
  expect(calls[0].body).toEqual({ digest: 'c'.repeat(64), enabled: true });
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  expect(calls).toHaveLength(1); // Required parameters are not sent empty.
  await page.getByRole('textbox', { name: 'target' }).fill('console');
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Jobs could not be updated' }),
  ).toContainText('Admission temporarily unavailable');
  await expect(page.getByRole('textbox', { name: 'target' })).toHaveValue(
    'console',
  );
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Open Work for status and cancellation' }),
  ).toHaveAttribute('href', '/work/01JOBSREQUEST');
  expect(calls.at(-1)?.body).toMatchObject({
    digest: 'c'.repeat(64),
    parameters: { target: 'console' },
  });
  // A newly installed recipe must not inherit parameters absent from its schema.
  jobs[0].enabled = false;
  jobs[0].definition!.digest = 'd'.repeat(64);
  jobs[0].definition!.parameters[0].key = 'frontend';
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
  await page.getByRole('button', { name: 'Review to enable' }).click();
  await page
    .getByRole('checkbox', { name: 'I reviewed this definition and recipe' })
    .check();
  await enable.click();
  await expect(page.getByText('Reviewed definition enabled.')).toBeVisible();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByRole('textbox', { name: 'frontend' }).fill('console');
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Open Work for status and cancellation' }),
  ).toBeVisible();
  expect(calls.at(-1)?.body).toMatchObject({
    parameters: { frontend: 'console' },
  });
  expect(calls.at(-1)?.body.parameters).not.toHaveProperty('target');
});

test('registry and selected detail fit phone, tablet and desktop in both themes', async ({
  page,
}) => {
  await page.route('**/api/work/v1/jobs', (route) =>
    route.fulfill({ json: catalog() }),
  );
  for (const scheme of ['dark', 'light'] as const) {
    await page.addInitScript(
      (value) => localStorage.setItem('mantine-color-scheme-value', value),
      scheme,
    );
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/jobs');
      await expect(
        page.getByText('3 registered', { exact: true }),
      ).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute(
        'data-mantine-color-scheme',
        scheme,
      );
      await expect(
        page.getByRole('button', { name: /Weekly security audit/ }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole('button', {
          name: /Frontend performance quality.*jlapenna\/agent-lcars/,
        })
        .click();
      await expect(
        page.getByRole('heading', {
          name: 'Frontend performance quality',
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Definition & recipe', exact: true })
        .click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (width < 768) {
        await page
          .getByRole('button', { name: 'All jobs', exact: true })
          .click();
        await expect(
          page.getByRole('heading', { name: 'Registered jobs' }),
        ).toBeFocused();
      }
    }
  }
});
