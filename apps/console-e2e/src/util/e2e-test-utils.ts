import { Page, test } from '@playwright/test';

/**
 * agent-lcars is a single-admin app gated by `assertAdmin()` (see
 * `apps/console/src/app/page.tsx`), so there's no non-admin persona to
 * distinguish; every test needs the same injected admin identity. Uses the
 * `X-e2e-auth-user` header read by `apps/console/src/auth.ts`'s
 * `getMockSession` and forwarded by `apps/console/src/proxy.ts`.
 */
const E2E_ADMIN_USER = {
  uid: 'e2e-agent-lcars-admin',
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

export async function setE2eAdminUser(page: Page) {
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

/** Locates a seeded CLI session's row by its fixture id (see
 * `E2E_CLI_SESSION_IDS` in `seed.ts`). */
export function cliSessionRow(page: Page, id: string) {
  return page.getByTestId(`cli-session-${id}`);
}
