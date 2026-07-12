/**
 * Seeds/clears fixture CLI session docs via the app's own `/api/e2e/seed`
 * route (`apps/agent-console/frontend/src/app/api/e2e/seed/route.ts`) rather
 * than writing to Firestore directly from the test process — direct writes
 * from here don't reach the store the running app server reads (see
 * `apps/members/e2e/frontend/src/seed.ts`'s note on the same gotcha).
 *
 * The identifiers below mirror the frontend app's fixture data exactly
 * (`apps/agent-console/frontend/src/app/api/e2e/seed/route.ts` and
 * `apps/agent-console/frontend/src/lib/e2e-fixtures.ts`). They're duplicated
 * rather than imported: this e2e project (`platform:web`) cannot import
 * directly from the `platform:nextjs` frontend app (same module-boundary
 * constraint documented on `apps/primes/frontend/src/app/api/e2e/seed-comments/route.ts`).
 */
export const E2E_CLI_SESSION_IDS = {
  live: 'e2e-cli-session-live',
  idle: 'e2e-cli-session-idle',
  ended: 'e2e-cli-session-ended',
  stale: 'e2e-cli-session-stale',
} as const;

export const E2E_FIXTURE_PR_NUMBER = 4242;
async function callSeedApi(action: 'seed' | 'reset') {
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
