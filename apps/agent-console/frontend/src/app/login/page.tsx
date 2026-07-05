import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { redirect } from 'next/navigation';

import { auth, signIn } from '../../auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await auth();
  if (session?.user?.isAdmin) {
    redirect('/');
  }

  return (
    <Center style={{ minHeight: '100vh' }}>
      <Stack align="center" gap="xs" style={{ maxWidth: 360 }}>
        <Title order={1}>Agent Console</Title>
        <Text c="dimmed" ta="center" mb="md">
          supersprinklesracing/members &mdash; Claude issue agent activity
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
