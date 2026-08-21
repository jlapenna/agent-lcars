import { expect, type Page, type Response, test } from '@playwright/test';

import {
  resetCliSessions,
  seedCliSessions,
  useCliSessionFixtures,
} from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';
import { seedOrchestratorTask } from './util/orchestrator-seed';

/**
 * agent-lcars#307 (part A).
 * see docs/e2e-security-boundary.md). This is the "complete mutation path
 * proven without real repositories, credentials, or paid model calls"
 * acceptance criterion: it drives the REAL Quick Task server action
 * (`apps/console/src/app/actions.ts`'s `createQuickTask`, not a helper or a
 * mock) through the browser UI, against an extended
 * `lib/e2e-github-fixtures.ts` that now behaves like a small stateful
 * GitHub - it assigns a real-looking incrementing issue number, remembers
 * the created issue so a later idempotency-lookup GET reflects it, and
 * synthesizes the marker-carrying workflow run a real router + dispatcher +
 * worker would eventually produce for the same create+label write. Broker
 * interactions exercised elsewhere in the suite stay inside the same local
 * GitHub fixture boundary (see that doc's security boundary).
 *
 * Together these prove, end to end and through real UI interaction:
 *  - canonical `TaskRef` identity (docs/quick-task-identity.md);
 *  - the one-write `intake:quick-task` + routed `agent:*` label contract;
 *  - request-ID idempotency (a retried request returns the same issue);
 *  - attempt presentation via #306's LogicalWork/ExecutionAttempt UI
 *    (already on main);
 *  - a definitive 4xx failing closed with no phantom issue.
 */

useE2eAdminBeforeEach();
useCliSessionFixtures();

/** Mirrors `E2E_QUICK_TASK_FORCE_4XX_DESCRIPTION` in
 * `apps/console/src/lib/e2e-github-fixtures.ts` (duplicated for the same
 * module-boundary reason `seed.ts`'s other mirrored constants are - this
 * `platform:web` e2e project cannot import from the `platform:nextjs`
 * frontend app). */
const FORCE_4XX_DESCRIPTION = 'E2E_QUICK_TASK_FORCE_4XX';
const DELAY_DESCRIPTION = 'E2E_QUICK_TASK_DELAY';

const TASK_REF_RE =
  /^Quick task filed as supersprinklesracing\/sprinkles#(\d+)$/;

/**
 * Stubs `crypto.randomUUID` to a fixed value so two independent Quick Task
 * modal open/submit cycles mint the SAME request ID. This is the only
 * legitimate way to exercise "the same request ID submitted twice" through
 * the real UI: `quick-task-button.tsx` only reuses its in-memory request ID
 * across a *failed* submission within the same modal session (see
 * `quick-task-button.test.tsx`'s "keeps the dialog open and reuses the
 * request ID after failure"), and a real ambiguous-failure retry can't be
 * forced from here without either faking the Server Action's wire protocol
 * or reaching into component internals - both far more fragile than pinning
 * the one source of entropy the button itself calls out to.
 */
async function stubRequestId(page: Page, uuid: string) {
  await page.addInitScript((fixedUuid) => {
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: () => fixedUuid,
    });
  }, uuid);
}

/** The single visible "Quick task" button on the Bridge - two
 * responsive variants are actually mounted (desktop/mobile, see page.tsx),
 * but Playwright's role locator only matches the accessible (non
 * `display:none`) one at the current viewport, so this never needs
 * `.first()` (matches the existing pattern in
 * lcars-interaction-states.spec.ts). */
async function openQuickTask(page: Page) {
  await page.getByRole('button', { name: 'Quick task' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function fillAndSubmit(page: Page, description: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Description').fill(description);
  await dialog.getByRole('button', { name: 'File & dispatch' }).click();
}

function taskRefNotification(page: Page) {
  return page.getByRole('link', { name: TASK_REF_RE });
}

/** Best-effort drain for Next's streamed Server Action response. The usable
 * payload can be complete while the framework keeps the stream open; page
 * cleanup must not turn that into an unbounded test gate (#519). */
async function drainActionResponse(response: Response): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      response.finished().then(() => undefined),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, 2_000);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

test.describe('Quick Task write path (agent-lcars#307)', () => {
  test('renders the current #20001 body immediately after a fixture generation reset (#991)', async ({
    page,
  }) => {
    async function fileAndReadBody(description: string) {
      await page.goto('/');
      await openQuickTask(page);
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Description').fill(description);
      const expectedBody =
        (await dialog.getByTestId('quick-task-preview-body').textContent()) ??
        '';
      await dialog.getByRole('button', { name: 'File & dispatch' }).click();

      const receipt = taskRefNotification(page);
      // This assertion spans the full Server Action plus its post-mutation
      // RSC refresh. Keep the same bounded saturation headroom as the other
      // receipt-count regression below; the cache-isolation assertion is the
      // immediate detail read after this completes, not action latency.
      await expect(receipt).toBeVisible({ timeout: 30_000 });
      const href = await receipt.getAttribute('href');
      const issueNumber = Number(href?.match(/\/issues\/(\d+)$/u)?.[1]);
      expect(issueNumber).toBe(20001);

      await page.goto(`/task/supersprinklesracing/sprinkles/${issueNumber}`);
      const overflow = page.getByRole('button', {
        name: `More actions for #${issueNumber}`,
      });
      await overflow.click();
      await page.getByRole('menuitem', { name: 'Edit issue' }).click();
      const editor = page.getByRole('dialog', {
        name: `Edit #${issueNumber}`,
      });
      await expect(editor.getByLabel('Title')).toHaveValue(description);
      await expect(editor.getByLabel('Body')).toHaveValue(expectedBody);
      await page.keyboard.press('Escape');
    }

    await fileAndReadBody('Fixture generation body A');

    // The reset deliberately reuses #20001. Before #991, a late cache fill
    // from the first detail render could commit after this invalidation and
    // make the next generation's first render return body A again.
    await resetCliSessions();
    await seedCliSessions();

    await fileAndReadBody('Fixture generation body B');
  });

  test('files a task through the real server action with canonical identity, one-write labels, a broker decision, and attempt presentation', async ({
    page,
  }) => {
    await page.goto('/');
    await openQuickTask(page);
    await fillAndSubmit(
      page,
      'E2E happy path: investigate the flaky retry test',
    );

    const receipt = taskRefNotification(page);
    await expect(receipt).toBeVisible();
    const receiptText = (await receipt.textContent()) ?? '';
    const match = TASK_REF_RE.exec(receiptText);
    expect(match).not.toBeNull();
    const issueNumber = match![1];
    await expect(receipt).toHaveAttribute(
      'href',
      `https://github.com/supersprinklesracing/sprinkles/issues/${issueNumber}`,
    );
    await expect(page.getByRole('dialog')).toBeHidden();

    // #1183/#1187: this fixture's quick-task creation only simulates the
    // GitHub-side write, so seed a real `@agent-lcars/orchestrator` task
    // directly against the emulator for this dynamically-created issue -
    // same as populated-dashboard.spec.ts's #9008 case (see
    // orchestrator-seed.ts's own doc comment for why a direct emulator
    // write here is safe). The exact pipeline value doesn't matter: only
    // the fixture workflow marker and the authoritative run are the same
    // deterministic first-generation intent, as they are in production.
    await seedOrchestratorTask({
      issue: Number(issueNumber),
      pipeline: 'claude',
      requestId: `e2e-fixture-seed:quick-task-write-path:${issueNumber}`,
      state: 'running',
    });

    // Canonical task detail page (agent-lcars#306's route) - the real read
    // path (task-detail.ts -> deriveLogicalWork -> LogicalWorkCard), not a
    // mock. Reaching this page at all proves the fixture's stateful
    // issue-create reflected the write on a subsequent GET.
    await page.goto(`/task/supersprinklesracing/sprinkles/${issueNumber}`);
    const card = page.getByTestId('logical-work-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('logical-work-state')).toHaveText('active');
    await expect(card).toContainText(`#${issueNumber}`);

    // Request + dispatch confirmation are two authoritative state changes.
    // The fixed request id keeps that history stable under a retried seed.
    await expect(card).toContainText('authoritative state rev 2');

    // Attempt presentation (#306's ExecutionAttempt UI): one running attempt
    // bound to the fixture's own run-name marker - never collapsed, never a
    // bare title guess. The marker is corroborated by authoritative state.
    const attempts = card.getByTestId('logical-work-attempts');
    await expect(attempts).toContainText('Execution attempts (1)');
    await expect(attempts).toContainText('running');
    await expect(attempts).toContainText('orchestrator');
    await expect(attempts).toContainText('g1');

    // A clean single-run dispatch renders no anomaly banner at all.
    await expect(card.getByTestId('logical-work-anomalies')).toHaveCount(0);
  });

  test('ctrl+enter in the description field files the task through the real server action, same as clicking the button (agent-lcars#269)', async ({
    page,
  }) => {
    await page.goto('/');
    await openQuickTask(page);
    const dialog = page.getByRole('dialog');
    const description = dialog.getByLabel('Description');
    await description.fill(
      'E2E ctrl+enter path: dispatch without touching the button',
    );
    await description.press('Control+Enter');

    const receipt = taskRefNotification(page);
    await expect(receipt).toBeVisible();
    await expect(receipt).toHaveAttribute(
      'href',
      /^https:\/\/github\.com\/supersprinklesracing\/sprinkles\/issues\/\d+$/,
    );
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('replaying the same request ID returns the same issue instead of creating a second one', async ({
    page,
  }) => {
    await stubRequestId(page, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await page.goto('/');
    // Auto-captured context (including its capture timestamp) is part of the
    // human-readable issue body and therefore its digest. Freeze the clock so
    // the two independent modal opens capture the same instant and the two
    // requests are genuinely byte-identical; a fixed UUID with a different
    // capture time must (correctly) conflict as different content.
    await page.clock.setFixedTime(new Date('2026-08-08T12:34:56.000Z'));

    const description = 'E2E idempotency check: same request ID twice';

    await openQuickTask(page);
    await fillAndSubmit(page, description);
    const firstReceipt = taskRefNotification(page);
    await expect(firstReceipt).toBeVisible();
    await expect(firstReceipt).toHaveAttribute(
      'href',
      /^https:\/\/github\.com\/supersprinklesracing\/sprinkles\/issues\/\d+$/,
    );
    const firstHref = await firstReceipt.getAttribute('href');

    // Idempotent retry resolves to the SAME TaskRef, so the second
    // submission's notification is byte-identical (same accessible name,
    // same href) to this one - and Mantine's notification stack
    // (AppProviders renders an unconfigured `<Notifications />`, so its
    // defaults apply: `limit: 5`, `autoClose: 4000`) genuinely keeps both
    // mounted at once rather than swapping one for the other. Re-querying
    // `taskRefNotification(page)` after the second submit would then match
    // TWO elements with an identical name/href and fail Playwright's strict
    // mode. Dismissing this one via its own close button - a real, ordinary
    // user action, not a test-only escape hatch - keeps exactly one match
    // live at a time without racing the 4s autoClose timer. Unlike scoping
    // the second assertion to `.last()`, this also still proves a NEW
    // notification actually appeared for the retry rather than vacuously
    // re-matching this one if it happened to still be visible.
    await page
      .getByRole('alert')
      .filter({ has: firstReceipt })
      .getByRole('button')
      .click();
    await expect(firstReceipt).toBeHidden();

    // A second, independent modal open/submit cycle with byte-identical
    // content. crypto.randomUUID is still stubbed to the same value, so the
    // real server action receives the exact same requestId + digest as the
    // first call - genuine request-ID idempotency, not merely
    // content-based deduplication (docs/quick-task-identity.md is explicit
    // that those are different: same content under a *different* ID is a
    // new, unrelated task).
    await openQuickTask(page);
    const retryActionRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        Boolean(request.headers()['next-action']),
      { timeout: 30_000 },
    );
    await fillAndSubmit(page, description);
    const actionRequest = await retryActionRequest;
    const secondReceipt = taskRefNotification(page);
    await expect(secondReceipt).toBeVisible();
    // Asserted against the locator (not a bare string equality on two
    // extracted values) to stay a web-first assertion - `firstHref` is
    // still the right expected value: proof the retry resolved to the
    // exact same issue rather than merely "some" issue.
    await expect(secondReceipt).toHaveAttribute('href', firstHref ?? '');
    // The receipt proves the Server Action payload already delivered its
    // result. Give that exact response a short best-effort drain before page
    // cleanup to avoid Next's false "destination stream closed early" log,
    // but do not make a framework stream that remains open an unbounded test
    // gate (#519). In the full serial suite Next can retain this response
    // after its usable payload is complete even though an isolated run closes
    // it immediately.
    const actionResponse = await actionRequest.response();
    expect(actionResponse).not.toBeNull();
    await drainActionResponse(actionResponse!);
  });

  test('files a second task while the first Server Action request is still pending', async ({
    page,
  }) => {
    await page.goto('/');

    await openQuickTask(page);
    await fillAndSubmit(page, DELAY_DESCRIPTION);
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(
      page.getByText('Filing and dispatching quick task…'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Quick task' }),
    ).toBeEnabled();

    await openQuickTask(page);
    await fillAndSubmit(page, 'Second quick task while the first is pending');
    await expect(page.getByRole('dialog')).toBeHidden();

    const seenReceipts = new Set<string>();
    await expect
      .poll(
        async () => {
          const hrefs = await taskRefNotification(page).evaluateAll((links) =>
            links.flatMap((link) =>
              link instanceof HTMLAnchorElement ? [link.href] : [],
            ),
          );
          for (const href of hrefs) seenReceipts.add(href);
          return seenReceipts.size;
        },
        { timeout: 30_000 },
      )
      .toBe(2);
  });

  test('edits a filed Quick Task without exposing or invalidating its identity marker', async ({
    page,
  }) => {
    const originalDescription = 'Original Quick Task description';
    await page.goto('/');
    await openQuickTask(page);
    const intake = page.getByRole('dialog');
    await intake.getByLabel('Description').fill(originalDescription);
    // Screenshot intake is now an upload/dropzone, not a URL field. Keep
    // this identity test on the uniquely named user-facing control without
    // crossing the hermetic suite's no-cloud-storage boundary.
    await expect(
      intake.getByRole('button', { name: 'Paste or drop a screenshot' }),
    ).toBeVisible();

    const previewTitle = intake.getByTestId('quick-task-preview-title');
    const previewBody = intake.getByTestId('quick-task-preview-body');
    await expect(previewTitle).toHaveText(originalDescription);
    await expect(previewBody).toContainText('## Source context');
    await expect(previewBody).toContainText(
      '- Repository: `supersprinklesracing/sprinkles`',
    );
    await expect(previewBody).toContainText('- Console route: `/`');
    await expect(previewBody).not.toContainText(
      'agent-lcars:quick-task-request',
    );
    const exactPreviewBody = (await previewBody.textContent()) ?? '';
    await intake.getByRole('button', { name: 'File & dispatch' }).click();

    const receipt = taskRefNotification(page);
    await expect(receipt).toBeVisible();
    const href = await receipt.getAttribute('href');
    const issueNumber = Number(href?.match(/\/issues\/(\d+)$/u)?.[1]);
    expect(issueNumber).toBeGreaterThan(0);

    await page.goto(`/task/supersprinklesracing/sprinkles/${issueNumber}`);
    // Detail pages contribute their canonical identity instead of making the
    // client infer it from hidden page data - proven here via the next
    // issue's own preview body, since the source block is captured
    // automatically rather than shown as editable fields.
    await openQuickTask(page);
    await intake.getByLabel('Description').fill('Follow-up quick task');
    await expect(previewBody).toContainText(
      `- Console route: \`/task/supersprinklesracing/sprinkles/${issueNumber}\``,
    );
    await expect(previewBody).toContainText(
      `- Task: supersprinklesracing/sprinkles#${issueNumber}`,
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    const overflow = page.getByRole('button', {
      name: `More actions for #${issueNumber}`,
    });
    await overflow.click();
    await page.getByRole('menuitem', { name: 'Edit issue' }).click();

    const editor = page.getByRole('dialog', {
      name: `Edit #${issueNumber}`,
    });
    await expect(editor.getByLabel('Title')).toHaveValue(originalDescription);
    // The exact preview crossed the real Server Action and GitHub fixture
    // unchanged. The edit path strips only the hidden identity marker.
    await expect(editor.getByLabel('Body')).toHaveValue(exactPreviewBody);
    await expect(editor.getByLabel('Body')).not.toHaveValue(
      /agent-lcars:quick-task-request/u,
    );

    await editor.getByLabel('Title').fill('Edited Quick Task title');
    await editor.getByLabel('Body').fill('Edited Quick Task description');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`#${issueNumber} updated`)).toBeVisible();
    await expect(overflow).toBeEnabled();

    await overflow.click();
    await page.getByRole('menuitem', { name: 'Edit issue' }).click();
    const reopened = page.getByRole('dialog', {
      name: `Edit #${issueNumber}`,
    });
    await expect(reopened.getByLabel('Title')).toHaveValue(
      'Edited Quick Task title',
    );
    await expect(reopened.getByLabel('Body')).toHaveValue(
      'Edited Quick Task description',
    );
  });

  test('a definitive 4xx from GitHub fails closed with no phantom issue', async ({
    page,
  }) => {
    await page.goto('/');
    await openQuickTask(page);
    await fillAndSubmit(page, FORCE_4XX_DESCRIPTION);

    // The Server Action surfaces GitHub's own error message (see
    // actions.ts's `toUserErrorMessage`) rather than a generic failure -
    // this is the fixture's forced-failure message flowing all the way
    // through the real create -> claim-release -> Server Action path.
    await expect(
      page.getByText('E2E fixture: forced definitive Quick Task failure'),
    ).toBeVisible();

    // The dialog closes immediately for non-blocking intake, but the failed
    // snapshot remains retryable under the same request ID. No success
    // receipt may appear for the rejected write.
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(taskRefNotification(page)).toHaveCount(0);
  });
});
