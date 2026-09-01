import { Page, test } from '@playwright/test';

/**
 * agent-lcars is a single-admin app gated by `assertAdmin()` (see
 * `apps/console/src/app/page.tsx`), so there's no non-admin persona to
 * distinguish; every test needs the same injected admin identity. Uses the
 * `X-e2e-auth-user` header read by `apps/console/src/auth.ts`'s
 * `getMockSession` and forwarded by `apps/console/src/proxy.ts`.
 */
// A GitHub-login-shaped identity, not a serialized profile: the console's
// strict Work admission records the authenticated actor in immutable Work.
// This header is admitted only by the non-Cloud-Run E2E adapter.
const E2E_ADMIN_GITHUB_LOGIN = 'e2e-agent-lcars-admin';

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
        'X-e2e-auth-user': E2E_ADMIN_GITHUB_LOGIN,
      },
    });
  });
}

/** Locates a seeded CLI session's row by its fixture id (see
 * `E2E_CLI_SESSION_IDS` in `seed.ts`). */
export function cliSessionRow(page: Page, id: string) {
  return page.getByTestId(`cli-session-${id}`);
}
