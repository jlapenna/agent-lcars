import { Container, Stack, Text, Title } from '@mantine/core';
import { redirect } from 'next/navigation';

import { auth } from '../auth';
import { ActionItemCard } from './action-item-card';
import { getActionItems } from './actions';
import { formatRelativeTime } from './format';

export const dynamic = 'force-dynamic';

export default async function Index() {
  const session = await auth();
  if (
    !session?.user?.isAdmin &&
    process.env.SKIP_AUTH_FOR_LAN_PREVIEW !== 'true'
  ) {
    redirect('/login');
  }

  const items = await getActionItems();
  const needsAction = items.filter((item) => item.actionTypes.length > 0);
  const rest = items.filter((item) => item.actionTypes.length === 0);

  return (
    <Container size="md" py="xl">
      <Title order={1}>Agent Console</Title>
      <Text c="dimmed" mt={4} mb="xl">
        supersprinklesracing/members &mdash; Claude issue agent activity
      </Text>

      <Title order={2} mb="sm">
        Needs Your Action ({needsAction.length})
      </Title>
      {needsAction.length === 0 && (
        <Text c="dimmed" mb="xl">
          Nothing waiting on you right now.
        </Text>
      )}
      <Stack gap="sm" mb="xl">
        {needsAction.map((item) => (
          <ActionItemCard
            key={`${item.kind}-${item.number}`}
            item={item}
            updatedAtLabel={formatRelativeTime(item.updatedAt)}
          />
        ))}
      </Stack>

      {rest.length > 0 && (
        <>
          <Title order={2} mb="sm">
            Everything Else ({rest.length})
          </Title>
          <Stack gap="sm">
            {rest.map((item) => (
              <ActionItemCard
                key={`${item.kind}-${item.number}`}
                item={item}
                updatedAtLabel={formatRelativeTime(item.updatedAt)}
              />
            ))}
          </Stack>
        </>
      )}
    </Container>
  );
}
