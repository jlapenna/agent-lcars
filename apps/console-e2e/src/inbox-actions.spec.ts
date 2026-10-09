import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { E2E_ITEM_NUMBERS, usePopulatedFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import {
  readTaskAdmission,
  seedTaskDeliverableHistory,
  updateDashboardAnchor,
} from './util/orchestrator-seed';

const REPOSITORY = 'supersprinklesracing/sprinkles';
const REPO_QUERY = encodeURIComponent(REPOSITORY);
const GITHUB = '/api/e2e/github';
const pathFor = (suffix: string) => `repos/${REPOSITORY}/${suffix}`;
interface Mutation {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  rejected: boolean;
}

useE2eAdminBeforeEach();
usePopulatedFixtures();

async function journal(request: APIRequestContext): Promise<Mutation[]> {
  const response = await request.get(`${GITHUB}/_fixture`);
  expect(response.ok()).toBe(true);
  // Anchor-refresh GraphQL reads use POST; they are reads, not effects.
  return (await response.json()).filter(
    (entry: Mutation) =>
      entry.path !== 'graphql' ||
      String(entry.body?.['query']).includes('mutation'),
  );
}

function claimEffects(number: number): Mutation[] {
  return [
    {
      method: 'POST',
      path: pathFor(`issues/${number}/reactions`),
      body: { content: 'eyes' },
      rejected: false,
    },
    {
      method: 'POST',
      path: pathFor(`issues/${number}/assignees`),
      body: { assignees: ['agent-lcars-bot'] },
      rejected: false,
    },
  ];
}

async function configure(
  request: APIRequestContext,
  data: {
    reject?: { method: string; path: string; message: string };
    pr?: {
      number: number;
      mergeableState: string;
      requestedReviewers: string[];
    };
  },
) {
  const response = await request.post(`${GITHUB}/_fixture`, { data });
  expect(response.ok()).toBe(true);
}

async function selectItem(page: Page, number: number) {
  await page.goto(`/inbox?repo=${REPO_QUERY}&sort=newest`);
  await page.getByTestId(`queue-row-${number}`).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`item=[^&]*${number}`));
  return page.url();
}

async function expectScope(page: Page, url: string) {
  await expect(page).toHaveURL(url);
  expect(new URL(page.url()).searchParams.get('repo')).toBe(REPOSITORY);
}

test.describe('Inbox authorized action journeys', () => {
  test('Comment only posts once without Work; a selected pipeline hands off once on mobile', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const number = E2E_ITEM_NUMBERS.humanNeededPostDeploy;
    const url = await selectItem(page, number);
    const detail = page.locator('.queue-workspace__detail');
    await detail.getByRole('button', { name: 'Reply…', exact: true }).click();
    const draft = detail.getByPlaceholder('Reply…', { exact: true });
    await expect(
      detail.getByText('Comment only', { exact: true }),
    ).toBeVisible();
    await draft.fill('Keep the human decision open.');
    await detail.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(
      page.getByText('No agent assigned - posted as a comment only', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(draft).toHaveValue('');
    expect(await journal(request)).toEqual([
      {
        method: 'POST',
        path: pathFor(`issues/${number}/comments`),
        body: { body: 'Keep the human decision open.' },
        rejected: false,
      },
    ]);
    expect(await readTaskAdmission(number)).toEqual({
      task: undefined,
      run: undefined,
    });
    const commentOnlyIssue = await request.get(
      `${GITHUB}/${pathFor(`issues/${number}`)}`,
    );
    expect((await commentOnlyIssue.json()).labels).toContainEqual({
      name: 'status:needs-human',
    });
    await expectScope(page, url);

    await detail.getByText('/codex', { exact: true }).click();
    await draft.fill('Use a 30-day retention window.');
    await detail
      .getByRole('button', { name: 'Reply & dispatch', exact: true })
      .click();
    await expect(
      page.getByText(`#${number}: Dispatched codex`, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => readTaskAdmission(number))
      .toMatchObject({
        task: {
          work: {
            origin: { principal: 'github:e2e-agent-lcars-admin' },
            spec: { pipeline: 'codex', target: { repo: REPOSITORY } },
          },
        },
        run: {
          pipeline: 'codex',
          state: 'running',
          params: { mode: 'implement' },
        },
      });
    const mutations = await journal(request);
    expect(
      mutations
        .filter(({ path }) => path.endsWith('/comments'))
        .map(({ body }) => body),
    ).toEqual([
      { body: 'Keep the human decision open.' },
      { body: 'Use a 30-day retention window.' },
    ]);
    expect(mutations.filter(({ path }) => path.endsWith('/labels'))).toEqual([
      {
        method: 'PUT',
        path: pathFor(`issues/${number}/labels`),
        body: {
          labels: [
            'status:needs-human',
            'status:post-deploy-action',
            'agent:codex',
          ],
        },
        rejected: false,
      },
    ]);
    expect(mutations).toEqual([
      {
        method: 'POST',
        path: pathFor(`issues/${number}/comments`),
        body: { body: 'Keep the human decision open.' },
        rejected: false,
      },
      {
        method: 'POST',
        path: pathFor(`issues/${number}/comments`),
        body: { body: 'Use a 30-day retention window.' },
        rejected: false,
      },
      ...claimEffects(number),
      {
        method: 'PUT',
        path: pathFor(`issues/${number}/labels`),
        body: {
          labels: [
            'status:needs-human',
            'status:post-deploy-action',
            'agent:codex',
          ],
        },
        rejected: false,
      },
      {
        method: 'DELETE',
        path: pathFor(`issues/${number}/labels/status:needs-human`),
        body: null,
        rejected: false,
      },
    ]);
    // QueueExecutor admissions stay durable; no legacy workflow or CI-flag write.
    expect(
      mutations.some(
        ({ path }) => path.includes('/actions/') || path.includes('/variables'),
      ),
    ).toBe(false);
    const assignedIssue = await request.get(
      `${GITHUB}/${pathFor(`issues/${number}`)}`,
    );
    expect((await assignedIssue.json()).labels).toEqual([
      { name: 'status:post-deploy-action' },
      { name: 'agent:codex' },
    ]);
    await expectScope(page, url);
    await expect(detail).toBeVisible();
    await expect(page.locator('.queue-workspace__list')).toBeHidden();
    await page
      .getByRole('link', { name: 'Back to Inbox list', exact: true })
      .click();
    expect(new URL(page.url()).searchParams.get('repo')).toBe(REPOSITORY);
    expect(new URL(page.url()).searchParams.get('sort')).toBe('newest');
    await expect(page.locator('.queue-workspace__list')).toBeVisible();
  });

  test('an assigned reply preserves its Work pipeline and carries the exact reply into a fresh run', async ({
    page,
    request,
  }) => {
    const number = E2E_ITEM_NUMBERS.humanNeeded;
    const url = await selectItem(page, number);
    const detail = page.locator('.queue-workspace__detail');
    await detail.getByRole('button', { name: 'Reply…', exact: true }).click();
    await detail.getByPlaceholder(/Reply/).fill('Choose 90 days.');
    await detail.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(
      page.getByText(`#${number}: Dispatched claude`, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => readTaskAdmission(number))
      .toMatchObject({
        task: { work: { spec: { pipeline: 'claude' } } },
        run: {
          pipeline: 'claude',
          state: 'running',
          params: { mode: 'reply', reply: 'Choose 90 days.' },
        },
      });
    expect(await journal(request)).toEqual([
      {
        method: 'POST',
        path: pathFor(`issues/${number}/comments`),
        body: { body: 'Choose 90 days.' },
        rejected: false,
      },
      ...claimEffects(number),
      {
        method: 'DELETE',
        path: pathFor(`issues/${number}/labels/status:needs-human`),
        body: null,
        rejected: false,
      },
    ]);
    await expectScope(page, url);
  });

  test('a rejected comment keeps its draft and admits no Work', async ({
    page,
    request,
  }) => {
    const number = E2E_ITEM_NUMBERS.humanNeededPostDeploy;
    const message = 'GitHub rejected this comment';
    await configure(request, {
      reject: {
        method: 'POST',
        path: pathFor(`issues/${number}/comments`),
        message,
      },
    });
    const url = await selectItem(page, number);
    const detail = page.locator('.queue-workspace__detail');
    await detail.getByRole('button', { name: 'Reply…', exact: true }).click();
    const draft = detail.getByPlaceholder(/Reply/);
    await draft.fill('Retain this rejected reply.');
    await detail.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(detail.getByText(message)).toBeVisible();
    await expect(draft).toHaveValue('Retain this rejected reply.');
    expect(await readTaskAdmission(number)).toEqual({
      task: undefined,
      run: undefined,
    });
    expect(await journal(request)).toEqual([
      {
        method: 'POST',
        path: pathFor(`issues/${number}/comments`),
        body: { body: 'Retain this rejected reply.' },
        rejected: true,
      },
    ]);
    await expectScope(page, url);
  });

  for (const action of ['merge', 'approve-rebase', 'rebase'] as const) {
    const number = E2E_ITEM_NUMBERS.reviewRequested;
    const approved = action !== 'rebase';
    const mergeableState = action === 'merge' ? 'clean' : 'behind';
    const requestedReviewers = approved
      ? [process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] ?? 'dummy-id']
      : [];
    const terminalPath = pathFor(
      `pulls/${number}/${action === 'merge' ? 'merge' : 'update-branch'}`,
    );
    const click = async (page: Page, request: APIRequestContext) => {
      const detail = page.locator('.queue-workspace__detail');
      if (action === 'rebase') {
        await detail
          .getByRole('button', { name: `More actions for #${number}` })
          .click();
        await page
          .getByRole('menuitem', {
            name: 'Rebase onto base branch',
            exact: true,
          })
          .click();
        return;
      }
      const label = action === 'merge' ? 'Approve & Merge' : 'Approve & Rebase';
      await detail.getByRole('button', { name: label, exact: true }).click();
      const dialog = page.getByRole('dialog', {
        name: `${action === 'merge' ? 'Merge' : 'Rebase'} #${number}?`,
      });
      await expect(dialog).toBeVisible();
      expect(await journal(request)).toEqual([]);
      await dialog.getByRole('button', { name: label, exact: true }).click();
    };
    for (const rejected of [false, true]) {
      const message = rejected
        ? `GitHub rejected ${action}`
        : action === 'merge'
          ? `#${number} merged`
          : action === 'rebase'
            ? `#${number} updated with the base branch`
            : `#${number} approved, branch updated, auto-merge enabled`;
      const configuration = {
        pr: { number, mergeableState, requestedReviewers },
        ...(rejected
          ? { reject: { method: 'PUT', path: terminalPath, message } }
          : {}),
      };
      const expectedEffects = [
        ...(approved
          ? [
              {
                method: 'POST',
                path: pathFor(`pulls/${number}/reviews`),
                body: { event: 'APPROVE' },
                rejected: false,
              },
            ]
          : []),
        {
          method: 'PUT',
          path: terminalPath,
          body: action === 'merge' ? { merge_method: 'squash' } : null,
          rejected,
        },
        ...(action === 'approve-rebase' && !rejected
          ? [
              {
                method: 'POST',
                path: 'graphql',
                body: expect.objectContaining({
                  variables: {
                    pullRequestId: `PR_e2e_${number}`,
                    mergeMethod: 'SQUASH',
                  },
                }),
                rejected: false,
              },
            ]
          : []),
      ];
      const expectedState = action === 'merge' && !rejected ? 'closed' : 'open';
      const expectedMergeable =
        action !== 'merge' && !rejected ? 'clean' : mergeableState;

      test(`${action} ${rejected ? 'reports provider rejection' : 'performs only its authorized effects'}`, async ({
        page,
        request,
      }) => {
        await configure(request, configuration);
        await updateDashboardAnchor({
          issue: number,
          mergeableState,
          requestedReviewerLogins: requestedReviewers,
        });
        const url = await selectItem(page, number);
        await click(page, request);
        await expect(page.getByText(message, { exact: true })).toBeVisible();
        expect(await journal(request)).toEqual(expectedEffects);
        const issue = await request.get(
          `${GITHUB}/${pathFor(`issues/${number}`)}`,
        );
        expect((await issue.json()).state).toBe(expectedState);
        const pr = await request.get(`${GITHUB}/${pathFor(`pulls/${number}`)}`);
        expect((await pr.json()).mergeable_state).toBe(expectedMergeable);
        expect((await readTaskAdmission(number)).run).toBeUndefined();
        await expectScope(page, url);
      });
    }
  }

  for (const rejected of [false, true]) {
    const message = rejected
      ? 'GitHub rejected Unstick audit creation'
      : 'unstick-prs runbook dispatched';
    const configuration = rejected
      ? { reject: { method: 'POST', path: pathFor('issues'), message } }
      : {};
    const expectedEffectsCount = rejected ? 1 : 3;
    const expectedClaims = rejected ? [] : claimEffects(9012);
    const admission = rejected
      ? { task: undefined, run: undefined }
      : {
          task: {
            work: {
              origin: { principal: 'github:e2e-agent-lcars-admin' },
              spec: { pipeline: 'claude', target: { repo: REPOSITORY } },
            },
          },
          run: {
            pipeline: 'claude',
            state: 'running',
            params: {
              mode: 'implement',
              runbook: 'unsticking-stuck-prs',
              context: '#9002: diagnose the failed E2E check only',
            },
          },
        };

    test(`Unstick ${rejected ? 'reports a provider rejection without admission' : 'creates an audit anchor and admits the scoped runbook'}`, async ({
      page,
      request,
    }) => {
      await configure(request, configuration);
      const url = await selectItem(page, E2E_ITEM_NUMBERS.runFailed);
      await page
        .locator('.queue-workspace__detail')
        .getByRole('button', { name: 'Unstick', exact: true })
        .click();
      const context = page.getByRole('textbox', { name: /Optional context/ });
      await expect(context).toHaveValue(
        '#9002 fix(watcher): stop double-counting streamed cache reads',
      );
      await context.fill('#9002: diagnose the failed E2E check only');
      await page.getByRole('button', { name: 'Dispatch', exact: true }).click();
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      const effects = await journal(request);
      expect(effects).toHaveLength(expectedEffectsCount);
      expect(effects.slice(1)).toEqual(expectedClaims);
      expect(effects[0]).toMatchObject({
        method: 'POST',
        path: pathFor('issues'),
        rejected,
        body: { labels: ['automation:unstick-prs'] },
      });
      expect(effects[0].body?.['body']).toContain(
        'Context: #9002: diagnose the failed E2E check only',
      );
      await expect.poll(() => readTaskAdmission(9012)).toMatchObject(admission);
      expect(
        (await readTaskAdmission(E2E_ITEM_NUMBERS.runFailed)).run,
      ).toBeUndefined();
      await expectScope(page, url);
    });
  }

  test('Open task follows the phone route into authoritative history and its deliverable', async ({
    page,
  }) => {
    await seedTaskDeliverableHistory();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?repo=${REPO_QUERY}`);
    await page
      .getByTestId(`live-run-group-${E2E_ITEM_NUMBERS.duplicateDispatch}`)
      .getByRole('link', { name: 'Open task', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(
      `/task/${REPOSITORY}/${E2E_ITEM_NUMBERS.duplicateDispatch}`,
    );
    const card = page.getByTestId('logical-work-card');
    await expect(card.getByTestId('logical-work-state')).toHaveText('anomaly');
    await expect(
      card.getByText('authoritative state rev 2', { exact: true }),
    ).toBeVisible();
    await expect(card.getByTestId('runs-section')).toContainText('Runs (3)');
    const completed = card.getByTestId(`run-${REPOSITORY}#9008/r0`);
    await expect(completed.getByTestId('run-state')).toHaveText('finished');
    await expect(
      completed.getByTestId(`run-events-${REPOSITORY}#9008/r0`),
    ).toContainText('(reported)');
    await expect(completed.getByTestId('run-result')).toContainText(
      'Delivered the repo filter chips',
    );
    await expect(completed.getByRole('link')).toHaveAttribute(
      'href',
      `https://github.com/${REPOSITORY}/pull/9420`,
    );
    await expect(
      card.getByTestId(`run-${REPOSITORY}#9008/r1`).getByTestId('run-state'),
    ).toHaveText('running');
    await expect(
      card.getByTestId(`run-${REPOSITORY}#9008/r2`).getByTestId('run-state'),
    ).toHaveText('pending');
  });
});
