'use client';

import type {
  TranscriptElisionDivider,
  TranscriptTimelineEvent,
} from '@agent-lcars/telemetry';
import {
  isElisionDivider,
  mergeTranscriptTimelinePages,
} from '@agent-lcars/telemetry';
import { Button, Group, Stack } from '@mantine/core';
import { useState } from 'react';

import type { TranscriptPageApiResponse } from '../../../lib/session-transcript';
import { OpsPanel } from '../../ops-primitives';
import { TranscriptTimelineView } from './transcript-timeline-view';

export interface PaginatedTranscriptViewProps {
  sessionId: string;
  initialEvents: (TranscriptTimelineEvent | TranscriptElisionDivider)[];
  initialNextCursor: string;
  initialWarning?: string;
}

export function PaginatedTranscriptView({
  sessionId,
  initialEvents,
  initialNextCursor,
  initialWarning,
}: PaginatedTranscriptViewProps) {
  const [events, setEvents] =
    useState<(TranscriptTimelineEvent | TranscriptElisionDivider)[]>(
      initialEvents,
    );
  const [nextCursor, setNextCursor] = useState<string | undefined>(
    initialNextCursor,
  );
  const [parseWarning, setParseWarning] = useState<string | undefined>(
    initialWarning,
  );
  const [fetchWarning, setFetchWarning] = useState<string | undefined>(
    undefined,
  );
  const [snapshotChanged, setSnapshotChanged] = useState(false);
  const [loading, setLoading] = useState(false);

  async function loadMore(): Promise<void> {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/transcript?cursor=${encodeURIComponent(nextCursor)}`;
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => undefined)) as
        Partial<TranscriptPageApiResponse> | undefined;

      if (response.status === 410) {
        setNextCursor(undefined);
        setFetchWarning(
          typeof payload?.warning === 'string'
            ? payload.warning
            : 'Transcript unavailable (archive retention expired).',
        );
        return;
      }

      if (response.status === 409) {
        setNextCursor(undefined);
        setSnapshotChanged(true);
        setFetchWarning(
          typeof payload?.warning === 'string'
            ? payload.warning
            : 'Transcript snapshot changed since this page loaded. Reload to view the updated archive.',
        );
        return;
      }

      if (!response.ok || !payload || !Array.isArray(payload.events)) {
        setFetchWarning(
          typeof payload?.warning === 'string'
            ? payload.warning
            : 'Failed to load more transcript events. Try again.',
        );
        return;
      }

      const incomingEvents = payload.events.filter(
        (entry): entry is TranscriptTimelineEvent => !isElisionDivider(entry),
      );
      setEvents((previous) =>
        mergeTranscriptTimelinePages(previous, incomingEvents),
      );
      setNextCursor(
        payload.hasMore && typeof payload.nextCursor === 'string'
          ? payload.nextCursor
          : undefined,
      );
      setFetchWarning(undefined);
      if (typeof payload.warning === 'string') {
        setParseWarning(payload.warning);
      }
    } catch {
      setFetchWarning('Failed to load more transcript events. Try again.');
    } finally {
      setLoading(false);
    }
  }

  const effectiveWarning = fetchWarning ?? parseWarning;

  return (
    <OpsPanel
      title="Transcript"
      count={nextCursor ? `${events.length}+` : events.length}
    >
      <Stack gap="sm">
        <TranscriptTimelineView
          events={events}
          warning={effectiveWarning}
          hasMore={Boolean(nextCursor)}
        />
        {nextCursor && (
          <Group justify="flex-start">
            <Button
              variant="default"
              size="sm"
              loading={loading}
              onClick={() => void loadMore()}
              data-testid="transcript-load-more"
              style={{ minHeight: 44 }}
            >
              Load more transcript
            </Button>
          </Group>
        )}
        {!nextCursor && snapshotChanged && (
          <Group justify="flex-start">
            <Button
              variant="default"
              size="sm"
              onClick={() => window.location.reload()}
              data-testid="transcript-reload"
              style={{ minHeight: 44 }}
            >
              Reload transcript
            </Button>
          </Group>
        )}
      </Stack>
    </OpsPanel>
  );
}
