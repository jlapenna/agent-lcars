'use client';

import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';

import type { SessionTrajectoryPreview } from '../lib/session-transcript';

export function DecisionTrajectory({
  runId,
  sessionId,
}: {
  runId: string;
  sessionId: string;
}) {
  const [preview, setPreview] = useState<
    SessionTrajectoryPreview | 'unavailable'
  >();
  const sessionHref = `/sessions/${encodeURIComponent(sessionId)}`;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ view: 'recent-messages', runId });
    void fetch(`/api${sessionHref}/transcript?${query}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Transcript unavailable');
        const result: SessionTrajectoryPreview = await response.json();
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview('unavailable');
      });
    return () => controller.abort();
  }, [runId, sessionHref]);

  return (
    <Stack gap="xs" component="section">
      <Group justify="space-between">
        <Title order={3} size="h5">
          Recent trajectory messages
        </Title>
        <Anchor href={sessionHref} size="sm">
          Open session
        </Anchor>
      </Group>
      {preview && preview !== 'unavailable' && preview.messages.length > 0 ? (
        <ol>
          {preview.messages.map(({ role, text }, index) => (
            <li key={index}>
              <Text size="xs" fw={600}>
                {role === 'assistant' ? 'Agent' : 'User'}
              </Text>
              <Text
                size="sm"
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {text}
              </Text>
            </li>
          ))}
        </ol>
      ) : (
        <Text component="p" size="sm" c="dimmed" role="status">
          {preview === undefined
            ? 'Loading recent messages…'
            : preview === 'unavailable'
              ? 'Recent messages are unavailable.'
              : 'No recent messages found in this archive.'}
        </Text>
      )}
    </Stack>
  );
}
