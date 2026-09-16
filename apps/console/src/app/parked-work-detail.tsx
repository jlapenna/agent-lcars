import type { ItemState, WorkSummary } from '@agent-lcars/work/derive';
import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';

import { formatRelativeTime } from './format';
import { githubIssueHref, summaryHref } from './parked-work-panel';
import { type WorkAction, WorkActions } from './work/work-actions';

const STATE_COLORS: Record<ItemState, string> = {
  parked: 'yellow',
  failed: 'red',
  running: 'blue',
  done: 'green',
  canceled: 'gray',
};

/**
 * The Bridge's right-hand detail for a "Stopped work" row - the same
 * cancel/redispatch controls the list row already offered, plus every run's
 * own outcome, so selecting a parked item answers "why did it stop, and what
 * did it try" without leaving the Bridge. `summaryHref` remains as an escape
 * hatch to the item's full page, which alone carries its conversation
 * transcript - a fetch this pane does not make.
 */
export function ParkedWorkDetail({
  item,
  cancel,
  redispatch,
}: {
  item: WorkSummary;
  cancel: WorkAction;
  redispatch: WorkAction;
}) {
  return (
    <Stack gap="md">
      <Group gap="xs">
        <Badge color={STATE_COLORS[item.state]} size="lg">
          {item.state}
        </Badge>
        <Text size="sm" c="dimmed">
          {item.spec.target.repo} · {item.spec.pipeline} · updated{' '}
          {formatRelativeTime(item.updatedAt)}
        </Text>
      </Group>
      {'workId' in item.anchor ? (
        <WorkActions
          id={item.anchor.workId}
          state={item.state}
          cancel={cancel}
          redispatch={redispatch}
        />
      ) : (
        <Anchor
          href={githubIssueHref(item.anchor)}
          target="_blank"
          rel="noreferrer"
          size="xs"
          c="dimmed"
        >
          Redispatch on GitHub (remove and re-add its <code>agent:*</code>{' '}
          label) ↗
        </Anchor>
      )}
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed">
          Runs ({item.runs.length})
        </Text>
        {item.runs.map((run) => (
          <Text key={run.runId} size="xs" c="dimmed">
            {run.runId} · {run.state}
            {run.result
              ? ` · ${run.result.ok ? 'ok' : 'not ok'}${
                  run.result.summary ? ` · ${run.result.summary}` : ''
                }`
              : ''}
          </Text>
        ))}
      </Stack>
      <Anchor href={summaryHref(item)} size="xs">
        View full history ↗
      </Anchor>
    </Stack>
  );
}
