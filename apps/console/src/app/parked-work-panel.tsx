import type { WorkSummary } from '@agent-lcars/work/derive';
import { Anchor, Group, Stack, Text, Title } from '@mantine/core';

import { formatRelativeTime } from './format';
import { type WorkAction, WorkActions } from './work/work-actions';

function summaryHref(item: WorkSummary): string {
  if ('workId' in item.anchor) return `/work/${item.anchor.workId}`;
  const [owner, repo] = item.anchor.repo.split('/');
  return `/task/${owner}/${repo}/${item.anchor.issue}`;
}

/** Pure renderer: hidden only when no parked work is present or truncated. */
export function ParkedWorkPanel({
  items,
  hasMoreTasks,
  cancel,
  redispatch,
}: {
  items: WorkSummary[];
  hasMoreTasks: boolean;
  cancel: WorkAction;
  redispatch: WorkAction;
}) {
  const parked = items
    .filter((item) => item.state === 'parked')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (parked.length === 0 && !hasMoreTasks) return null;
  return (
    <section aria-label="Parked work" data-testid="parked-work-panel">
      <Title order={3} size="h5">
        Parked work ({parked.length})
      </Title>
      {parked.length === 0 ? (
        <Text size="sm" c="dimmed" mt="xs">
          No parked work in the 200 most recently updated tasks.
        </Text>
      ) : (
        <Stack gap="xs" mt="xs">
          {parked.map((item) => {
            const latest = item.runs[item.runs.length - 1];
            return (
              <Group key={item.id} justify="space-between" wrap="wrap" gap="sm">
                <Stack gap={2}>
                  <Anchor href={summaryHref(item)} size="sm" fw={600}>
                    {item.spec.title}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {item.spec.target.repo} ·{' '}
                    <span>{latest?.result?.summary ?? 'lost'}</span> · parked{' '}
                    {formatRelativeTime(item.updatedAt)}
                  </Text>
                </Stack>
                {'workId' in item.anchor && (
                  <WorkActions
                    id={item.anchor.workId}
                    state={item.state}
                    cancel={cancel}
                    redispatch={redispatch}
                  />
                )}
              </Group>
            );
          })}
        </Stack>
      )}
      {hasMoreTasks && (
        <Text size="xs" c="dimmed" mt="xs">
          Older tasks may contain parked work.
        </Text>
      )}
    </section>
  );
}
