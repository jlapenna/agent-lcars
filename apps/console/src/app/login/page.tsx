import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth, signIn, signOut } from '../../auth';
import { PageLoading } from '../page-loading';

async function LoginPageContent() {
  const session = await auth();
  if (session?.user?.isAdmin) {
    redirect('/');
  }

  // Signed in but not an admin: without this branch the page re-renders
  // the sign-in button with no explanation, and every guarded route
  // bounces straight back here - it reads as a redirect loop rather than
  // a permissions decision.
  const signedInAs = session?.user?.email ?? session?.user?.name;

  return (
    <Center style={{ minHeight: '100vh' }}>
      <Stack align="center" gap="xs" style={{ maxWidth: 360 }}>
        <Title order={1}>Agent LCARS</Title>
        <Text c="dimmed" ta="center" mb="md">
          supersprinklesracing/sprinkles &mdash; Claude issue agent activity
        </Text>
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

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, so the page body streams in behind 2-row placeholder rather
// than blocking the whole route on the GitHub/Firestore reads.
export default function LoginPage() {
  return (
    <Suspense fallback={<PageLoading rows={2} />}>
      <LoginPageContent />
    </Suspense>
  );
}
