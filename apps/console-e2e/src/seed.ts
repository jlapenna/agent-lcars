import { test } from '@playwright/test';

/**
 * Seeds/clears fixture CLI session docs via the app's own `/api/e2e/seed`
 * route (`apps/console/src/app/api/e2e/seed/route.ts`) rather than writing
 * to Firestore directly from the test process — direct writes from here
 * don't reach the store the running app server reads.
 *
 * The identifiers below mirror the frontend app's fixture data exactly
 * (`apps/console/src/app/api/e2e/seed/route.ts` and
 * `apps/console/src/lib/e2e-fixtures.ts`). They're duplicated rather than
 * imported: this e2e project (`platform:web`) cannot import directly from
 * the `platform:nextjs` frontend app (a module-boundary constraint, not
 * merely a convenience choice).
 */
export const E2E_CLI_SESSION_IDS = {
  live: 'e2e-cli-session-live',
  idle: 'e2e-cli-session-idle',
  ended: 'e2e-cli-session-ended',
  stale: 'e2e-cli-session-stale',
} as const;

export const E2E_FIXTURE_PR_NUMBER = 4242;

/** Populated-mode identifiers, mirroring `E2E_ITEM_NUMBERS` /
 * `E2E_ISSUE_AGENT_SESSION_ID` in the frontend app (duplicated for the same
 * module-boundary reason as the ids above). */
export const E2E_ITEM_NUMBERS = {
  humanNeeded: 9001,
  runFailed: 9002,
  reviewRequested: 9003,
  postDeploy: 9004,
  silentError: 9005,
  readyForAgent: 9006,
  humanNeededPostDeploy: 9010,
  ledgerDuplicateDispatch: 9008,
} as const;

/** Mirrors `E2E_LEDGER_INTENT_ID` in the frontend app's
 * `lib/e2e-github-fixtures.ts` (same module-boundary reason as the ids
 * above). */
export const E2E_LEDGER_INTENT_ID = 'e2e-fixture-intent-9008';

export const E2E_ISSUE_AGENT_SESSION_ID = 'e2e-issue-agent-session';

async function callSeedApi(action: 'seed' | 'seed-populated' | 'reset') {
  const baseURL = process.env['BASE_URL'] || 'http://127.0.0.1:4200';
  const response = await fetch(`${baseURL}/api/e2e/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to ${action} CLI session fixtures: ${response.status} ${text}`,
    );
  }
}

export async function seedCliSessions() {
  await callSeedApi('seed');
}

export async function resetCliSessions() {
  await callSeedApi('reset');
}

/**
 * Turns on the full populated fixture set (#40): the CLI sessions above,
 * plus an `issue-agent` session doc, plus the action items, workflow runs,
 * and runner fleet served by `/api/e2e/github` — which stay invisible
 * otherwise, so the older specs keep asserting the zero state they were
 * written against.
 */
export async function seedPopulatedFixtures() {
  await callSeedApi('seed-populated');
}

/**
 * Registers the seed/clear hooks for one fixture set. Both exported
 * wrappers below funnel through this rather than each declaring their own
 * `beforeEach`/`afterAll` — two hook pairs in one module read as duplicate
 * hooks in a single describe block to `eslint-plugin-playwright`, even
 * though a spec only ever calls one of them.
 */
function useFixtures(seed: () => Promise<void>) {
  test.beforeEach(async () => {
    await resetCliSessions();
    await seed();
  });

  test.afterAll(async () => {
    await resetCliSessions();
  });
}

/** Seeds/clears the populated set around every test in a spec. */
export function usePopulatedFixtures() {
  useFixtures(seedPopulatedFixtures);
}

/** Seeds the fixture CLI sessions above before every test in the spec and
 * clears them once after the whole suite finishes. */
export function useCliSessionFixtures() {
  useFixtures(seedCliSessions);
}
