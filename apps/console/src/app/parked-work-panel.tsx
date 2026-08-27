import type { ItemView } from '@agent-lcars/work/derive';
import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import type { ComponentProps } from 'react';

import { formatRelativeTime } from './format';
import { WorkActions } from './work/work-actions';

// `WorkActions` doesn't export its `WorkAction` callback type - derive it
// from the component's own props instead of duplicating the tuple shape it
// declares locally, so this stays in sync with the real signature.
type WorkAction = ComponentProps<typeof WorkActions>['cancel'];

/** Pure renderer: hidden at zero parked items; oldest-parked first. */
export function ParkedWorkPanel({
  items,
  cancel,
  redispatch,
}: {
  items: ItemView[];
  cancel: WorkAction;
  redispatch: WorkAction;
}) {
  const parked = items
    .filter((item) => item.state === 'parked')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (parked.length === 0) return null;
  return (
    <section aria-label="Parked work" data-testid="parked-work-panel">
      <Title order={3} size="h5">
        Parked work ({parked.length})
      </Title>
      <Stack gap="xs" mt="xs">
        {parked.map((item) => {
          const latest = item.runs[item.runs.length - 1];
          return (
            <Group key={item.id} justify="space-between" wrap="wrap" gap="sm">
              <Stack gap={2}>
                <Anchor href={`/work/${item.id}`} size="sm" fw={600}>
                  {item.spec.title}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {item.spec.target.repo} ·{' '}
                  <span>{latest?.result?.summary ?? 'lost'}</span> · parked{' '}
                  {formatRelativeTime(item.updatedAt)}
                </Text>
              </Stack>
              <WorkActions
                id={item.id}
                state={item.state}
                cancel={cancel}
                redispatch={redispatch}
              />
            </Group>
          );
        })}
      </Stack>
    </section>
  );
}
