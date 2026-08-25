import { Button, Center, Stack, Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth, signIn, signOut } from '../../auth';
import { consoleDescription } from '../../lib/deployment';
import { NavPageLoading } from '../page-loading';
import { withConsolePageShell } from '../with-console-page-shell';

async function LoginContent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user?.isAdmin) {
    redirect('/');
  }

  // Two ways to be unauthorized, both previously rendered as a bare
  // sign-in button that read like a redirect loop:
  // - auth.ts's signIn callback rejects non-admin GitHub logins before a
  //   session exists; Auth.js then lands here with ?error=AccessDenied -
  //   the production-path signal (Codex review on #491).
  // - A session can exist without isAdmin (e.g. the configured admin
  //   login changed since sign-in); that session-present branch also
  //   offers sign-out.
  const { error } = await searchParams;
  const accessDenied = error === 'AccessDenied';
  const signedInAs = session?.user?.email ?? session?.user?.name;

  return (
    <Center mih="60vh">
      <Stack align="center" gap="xs" style={{ maxWidth: 360 }}>
        <Text c="dimmed" ta="center" mb="md">
          {consoleDescription()}
        </Text>
        {accessDenied && !session && (
          <Text ta="center" size="sm" data-testid="login-unauthorized">
            That GitHub account isn&rsquo;t authorized for this console. Sign in
            with an authorized account.
          </Text>
        )}
        {session ? (
          <>
            <Text ta="center" size="sm" data-testid="login-unauthorized">
              {signedInAs ? `Signed in as ${signedInAs}, but this` : 'This'}{' '}
              account isn&rsquo;t authorized for the console. Sign out and use
              an authorized account.
            </Text>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/login' });
              }}
            >
              <Button type="submit" variant="default" size="md">
                Sign out
              </Button>
            </form>
          </>
        ) : (
          <form
            action={async () => {
              'use server';
              await signIn('github');
            }}
          >
            <Button type="submit" color="dark" size="md">
              Sign in with GitHub
            </Button>
          </form>
        )}
      </Stack>
    </Center>
  );
}

const LoginPageContent = withConsolePageShell(LoginContent, {
  current: 'deck',
  title: 'Agent LCARS',
  subtitle: 'Sign in to the operations console.',
});

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, so the page body streams in behind 2-row placeholder rather
// than blocking the whole route on the GitHub/Firestore reads.
export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="deck"
          title="Agent LCARS"
          className="login-page-shell"
          rows={2}
        />
      }
    >
      <LoginPageContent searchParams={searchParams} />
    </Suspense>
  );
}
