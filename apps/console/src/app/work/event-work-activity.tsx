import type { ItemView, WorkSummary } from '@agent-lcars/work/derive';
import { latestRun } from '@agent-lcars/work/derive';
import { Anchor, Group, Stack, Text } from '@mantine/core';

import { OpsPanel } from '../ops-primitives';
import { RelativeTime } from '../relative-time';
import { RemainderDisclosure } from '../remainder-disclosure';
import { eventOperation, eventSource } from './event-work';
import type { WorkListParams } from './work-list-query';

/** Event rows the Bridge lists before its disclosure. */
export const EVENT_WORK_SHOWN = 10;

function EventWorkRow({ item }: { item: WorkSummary }) {
  const run = latestRun(item.runs);
  if (!run || !('workId' in item.anchor)) return null;
  return (
    <div>
      <Group justify="space-between" gap="xs">
        <Anchor href={`/work/${item.anchor.workId}`}>{item.spec.title}</Anchor>
        <Text size="xs">{item.state}</Text>
      </Group>
      <Text size="xs" c="dimmed">
        {eventOperation(run)} ·{' '}
        <RelativeTime iso={item.updatedAt} variant="compact" />
        {run.triagePublication
          ? ` · Publication ${run.triagePublication.state}`
          : ''}
      </Text>
      {run.result?.ok === false && run.result.summary !== 'superseded' && (
        <Text size="xs" c="red">
          {run.result.summary}
        </Text>
      )}
    </div>
  );
}

/**
 * Event-driven work among the most recent event tasks the Bridge reads. The
 * newest {@link EVENT_WORK_SHOWN} are listed; every other match in that read
 * sits behind a disclosure, and Work lists older activity. `windowed` says
 * the read stopped before the oldest task, so the count is a lower bound.
 */
export function EventWorkActivity({
  items,
  error,
  repo,
  view = {},
  windowSize,
  windowed = false,
}: {
  /** Every match in the read window, newest first. */
  items: WorkSummary[];
  error?: string;
  repo?: string;
  view?: Pick<WorkListParams, 'agent' | 'window' | 'q'>;
  /** Tasks the Bridge read to find these matches. */
  windowSize?: number;
  windowed?: boolean;
}) {
  const query = new URLSearchParams({
    activity: 'events',
    ...(repo ? { repo } : {}),
  });
  for (const [key, value] of Object.entries(view))
    if (value) query.set(key, value);
  const shown = items.slice(0, EVENT_WORK_SHOWN);
  return (
    <OpsPanel
      title="Event-driven work"
      count={`${items.length}${windowed ? '+' : ''}`}
      meta="Recent source updates"
      aria-label="Event-driven work"
    >
      <Stack gap="sm">
        {error ? (
          <Text role="alert">Could not load event-driven work.</Text>
        ) : items.length === 0 ? (
          <Text size="sm" c="dimmed">
            No event-driven work in the recent activity window.
          </Text>
        ) : (
          shown.map((item) => <EventWorkRow key={item.id} item={item} />)
        )}
        {!error && (
          <RemainderDisclosure
            shown={shown.length}
            total={items.length}
            noun="event-driven tasks"
            data-testid="event-work-remainder"
          >
            <Stack gap="sm">
              {items.slice(EVENT_WORK_SHOWN).map((item) => (
                <EventWorkRow key={item.id} item={item} />
              ))}
            </Stack>
          </RemainderDisclosure>
        )}
        <Anchor href={`/work?${query}`} size="sm">
          View event-driven work →
        </Anchor>
        {windowSize !== undefined && (
          <Text size="xs" c="dimmed">
            {windowed
              ? `Matches among the ${windowSize} most recent event tasks. Older activity is available in Work.`
              : `Every match among all ${windowSize} event tasks.`}
          </Text>
        )}
      </Stack>
    </OpsPanel>
  );
}

export function WorkSourceEvents({ item }: { item: ItemView }) {
  const runs = item.runs.filter((run) => run.sourceRevision !== undefined);
  if (!runs.length) return null;
  return (
    <OpsPanel title="Source activity" count={runs.length}>
      <Stack gap="md">
        {runs.map((run) => {
          const source = eventSource(run, item.spec);
          const publication = run.triagePublication;
          const commentHref =
            publication?.commentId &&
            source.href?.startsWith('https://github.com/')
              ? `${source.href}#issuecomment-${publication.commentId}`
              : undefined;
          return (
            <div key={run.runId}>
              <Text size="sm" fw={600}>
                {eventOperation(run)} · attempt {run.revisionAttempt ?? 1}
              </Text>
              <Text size="sm">
                {source.href ? (
                  <Anchor href={source.href}>{source.label}</Anchor>
                ) : (
                  source.label
                )}
              </Text>
              <Text size="xs" c="dimmed">
                Admitted <RelativeTime iso={run.createdAt} /> · {run.state}
                {run.result
                  ? ` · ${run.result.summary === 'superseded' || publication?.state === 'superseded' ? 'Superseded' : `${run.result.ok ? 'Succeeded' : 'Failed'}: ${run.result.summary}`}`
                  : ''}
              </Text>
              {Object.entries(run.sourceRevision?.observedAt ?? {}).map(
                ([name, at]) => (
                  <Text key={name} size="xs">
                    {name} source observed <RelativeTime iso={at} />
                  </Text>
                ),
              )}
              {publication && (
                <Text size="sm">
                  Publication {publication.state}
                  {publication.error ? ` — ${publication.error}` : ''}
                  {commentHref && (
                    <>
                      {' '}
                      ·{' '}
                      <Anchor href={commentHref}>
                        Published triage report ↗
                      </Anchor>
                    </>
                  )}
                </Text>
              )}
              <Anchor size="xs" href={`#run-${run.runId}`}>
                View attempt details
              </Anchor>
            </div>
          );
        })}
      </Stack>
    </OpsPanel>
  );
}
