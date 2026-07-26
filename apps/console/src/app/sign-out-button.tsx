import { UnstyledButton } from '@mantine/core';

import { signOut } from '../auth';

/**
 * Ends the NextAuth session and returns to the login screen (#27) - until
 * this existed the only way out of a signed-in console was to clear the
 * cookie by hand.
 *
 * A server component wrapping a form + server action rather than a client
 * component calling `signOut()` in the browser, mirroring the login page's
 * `signIn('github')` form: the session cookie is httpOnly, so clearing it
 * is server work either way, and this keeps `auth.ts` (and its
 * server-only deps) out of any client bundle.
 *
 * Styled as text, matching ThemeToggle - both are low-frequency controls
 * parked in the footer rather than competing with a page's real actions
 * (see console-footer.tsx).
 */
export function SignOutButton() {
  return (
    <form
      action={async () => {
        'use server';
        await signOut({ redirectTo: '/login' });
      }}
    >
      <UnstyledButton type="submit" fz="xs" c="dimmed">
        Sign out
      </UnstyledButton>
    </form>
  );
}
