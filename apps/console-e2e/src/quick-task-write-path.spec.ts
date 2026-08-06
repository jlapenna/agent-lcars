import { expect, Page, test } from '@playwright/test';

import { useCliSessionFixtures } from './seed';
import { useE2eAdminBeforeEach } from './util/e2e-test-utils';

/**
 * agent-lcars#307 (part A, split from the epic's production canary half -
 * see docs/e2e-security-boundary.md). This is the "complete mutation path
 * proven without real repositories, credentials, or paid model calls"
 * acceptance criterion: it drives the REAL Quick Task server action
 * (`apps/console/src/app/actions.ts`'s `createQuickTask`, not a helper or a
 * mock) through the browser UI, against an extended
 * `lib/e2e-github-fixtures.ts` that now behaves like a small stateful
 * GitHub - it assigns a real-looking incrementing issue number, remembers
 * the created issue so a later idempotency-lookup GET reflects it, and
 * synthesizes the pinned dispatch-ledger comment plus bound workflow run a
 * real router + broker + worker would eventually produce for the same
 * create+label write (this suite never runs the actual broker action - see
 * that doc's security boundary).
 *
 * Together these prove, end to end and through real UI interaction:
 *  - canonical `TaskRef` identity (docs/quick-task-identity.md);
 *  - the one-write `intake:quick-task` + routed `agent:*` label contract;
 *  - request-ID idempotency (a retried request returns the same issue);
 *  - the broker's decision (ledger comment) rendering as one dispatch
 *    intent;
 *  - attempt presentation via #306's LogicalWork/ExecutionAttempt UI
 *    (already on main);
 *  - a definitive 4xx failing closed with no phantom issue.
 */

useE2eAdminBeforeEach();
useCliSessionFixtures();

/** Mirrors `E2E_QUICK_TASK_FORCE_4XX_TITLE` in
 * `apps/console/src/lib/e2e-github-fixtures.ts` (duplicated for the same
 * module-boundary reason `seed.ts`'s other mirrored constants are - this
 * `platform:web` e2e project cannot import from the `platform:nextjs`
 * frontend app). Typing this into the real "Title" field is the only way to
 * deterministically drive a definitive-4xx fixture response through the
 * real UI: every other field it controls (description, pipeline, repo) is
 * otherwise always valid. */
const FORCE_4XX_TITLE = 'E2E_QUICK_TASK_FORCE_4XX';

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

async function fillAndSubmit(
  page: Page,
  { title, description }: { title?: string; description: string },
) {
  const dialog = page.getByRole('dialog');
  if (title !== undefined) {
    await dialog.getByLabel('Title').fill(title);
  }
  await dialog.getByLabel('Description').fill(description);
  await dialog.getByRole('button', { name: 'File & dispatch' }).click();
}

function taskRefNotification(page: Page) {
  return page.getByRole('link', { name: TASK_REF_RE });
}

test.describe('Quick Task write path (agent-lcars#307)', () => {
  test('files a task through the real server action with canonical identity, one-write labels, a broker decision, and attempt presentation', async ({
    page,
  }) => {
    await page.goto('/');
    await openQuickTask(page);
    await fillAndSubmit(page, {
      description: 'E2E happy path: investigate the flaky retry test',
    });

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

    // Canonical task detail page (agent-lcars#306's route) - the real read
    // path (task-detail.ts -> deriveLogicalWork -> LogicalWorkCard), not a
    // mock. Reaching this page at all proves the fixture's stateful
    // issue-create reflected the write on a subsequent GET.
    await page.goto(`/task/supersprinklesracing/sprinkles/${issueNumber}`);
    const card = page.getByTestId('logical-work-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('logical-work-state')).toHaveText('active');
    await expect(card).toContainText(`#${issueNumber}`);

    // Broker decision: one accepted+dispatched generation, attributed to
    // the `labeled` source event the one-write create+label call produced.
    const intents = card.getByTestId('logical-work-intents');
    await expect(intents).toBeVisible();
    await expect(intents).toContainText('g1');
    await expect(intents).toContainText('via labeled');

    // Attempt presentation (#306's ExecutionAttempt UI): one ledger-
    // attributed, running attempt bound to that same generation - never
    // collapsed, never a bare title/run-marker guess.
    const attempts = card.getByTestId('logical-work-attempts');
    await expect(attempts).toContainText('Execution attempts (1)');
    await expect(attempts).toContainText('running');
    await expect(attempts).toContainText('ledger');
    await expect(attempts).toContainText('g1');

    // A clean single-generation dispatch renders no anomaly banner at all.
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

    const description = 'E2E idempotency check: same request ID twice';

    await openQuickTask(page);
    await fillAndSubmit(page, { description });
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
    await fillAndSubmit(page, { description });
    const secondReceipt = taskRefNotification(page);
    await expect(secondReceipt).toBeVisible();
    // Asserted against the locator (not a bare string equality on two
    // extracted values) to stay a web-first assertion - `firstHref` is
    // still the right expected value: proof the retry resolved to the
    // exact same issue rather than merely "some" issue.
    await expect(secondReceipt).toHaveAttribute('href', firstHref ?? '');
  });

  test('a definitive 4xx from GitHub fails closed with no phantom issue', async ({
    page,
  }) => {
    await page.goto('/');
    await openQuickTask(page);
    await fillAndSubmit(page, {
      title: FORCE_4XX_TITLE,
      description: 'E2E 4xx check: this attempt must fail closed',
    });

    // The Server Action surfaces GitHub's own error message (see
    // actions.ts's `toUserErrorMessage`) rather than a generic failure -
    // this is the fixture's forced-failure message flowing all the way
    // through the real create -> claim-release -> Server Action path.
    await expect(
      page.getByText('E2E fixture: forced definitive Quick Task failure'),
    ).toBeVisible();

    // Failure never closes the dialog (quick-task-button.tsx only calls
    // close() on success) and never shows a success receipt - the UI must
    // not pretend a task was filed when GitHub definitively rejected it.
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(taskRefNotification(page)).toHaveCount(0);
  });
});
