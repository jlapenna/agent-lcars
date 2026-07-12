import { Page, test } from '@playwright/test';

/**
 * agent-console is a single-admin app gated by `assertAdmin()` (see
 * `apps/agent-console/frontend/src/app/page.tsx`), so — unlike the primes
 * suite this mirrors — there's no non-admin persona to distinguish; every
 * test needs the same injected admin identity. Uses the shared
 * `X-e2e-auth-user` test-session adapter (`libs/auth/src/server/test-session.ts`),
 * the same mechanism every Next.js app in this repo now uses for e2e auth.
 */
const E2E_ADMIN_USER = {
  uid: 'e2e-agent-console-admin',
  email: 'e2e-admin@example.com',
  displayName: 'E2E Admin',
  emailVerifed: true,
  customClaims: { roles: ['admin'] },
};

export function useE2eAdminBeforeEach() {
  test.beforeEach(async ({ page }) => {
    await setE2eAdminUser(page);
  });
}

async function setE2eAdminUser(page: Page) {
  await page.route('**/*', async (route) => {
    const headers = route.request().headers();
    await route.continue({
      headers: {
        ...headers,
        'X-e2e-auth-user': JSON.stringify(E2E_ADMIN_USER),
      },
    });
  });
}
