import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth, signIn } from '../../auth';
import { PageLoading } from '../page-loading';

async function LoginPageContent() {
  const session = await auth();
  if (session?.user?.isAdmin) {
    redirect('/');
  }

  return (
    <Center style={{ minHeight: '100vh' }}>
      <Stack align="center" gap="xs" style={{ maxWidth: 360 }}>
        <Title order={1}>Agent LCARS</Title>
        <Text c="dimmed" ta="center" mb="md">
          supersprinklesracing/sprinkles &mdash; Claude issue agent activity
        </Text>
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
