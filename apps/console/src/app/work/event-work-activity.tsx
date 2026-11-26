import type { ItemView } from '@agent-lcars/work/derive';
import { Anchor, Stack, Text } from '@mantine/core';

import { OpsPanel } from '../ops-primitives';
import { RelativeTime } from '../relative-time';
import { eventOperation, eventSource } from './event-work';

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
