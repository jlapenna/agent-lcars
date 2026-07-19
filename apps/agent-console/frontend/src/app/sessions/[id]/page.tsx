import { Anchor, Container, Group, Stack, Text, Title } from '@mantine/core';
import { assertAdmin } from '@repo/auth/server';
import { notFound } from 'next/navigation';

import { auth } from '../../../auth';
import { getSessionDetail } from '../../../lib/session-detail';
import { formatRelativeTime } from '../../format';
import { RefreshButton } from '../../refresh-button';
import { ThemeToggle } from '../../theme-toggle';
import { SessionHeader } from './session-header';
import { TranscriptTimelineView } from './transcript-timeline-view';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * A single session's detail view: full header (identity, cost/token totals,
 * source-specific fields, deliverables, artifacts) plus - for an
 * issue-agent session whose transcript was archived to GCS - the turn-by-
 * turn transcript timeline. A missing doc is a real 404; every other
 * failure mode (store read failure, GCS fetch/parse failure) fails soft to
 * a warning rather than a 500 - see session-detail.ts/session-transcript.ts
 * for where each of those is absorbed.
 */
export default async function SessionDetailPage({ params }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const { id } = await params;
  const detail = await getSessionDetail(id);

  if (detail.status === 'not-found') {
    notFound();
  }

  const generatedAt = new Date().toISOString();

  return (
    <Container size="md" py="xl">
      <Group justify="space-between" align="flex-start" gap="sm" mb="xl">
        <Anchor href="/sessions" size="sm">
          ← Session archive
        </Anchor>
        <Group gap="sm">
          <RefreshButton
            generatedAt={generatedAt}
            initialLabel={formatRelativeTime(generatedAt)}
          />
          <ThemeToggle size="lg" />
        </Group>
      </Group>

      {detail.status === 'error' && (
        <Text size="sm" c="orange" mb="md" data-testid="session-detail-error">
          {detail.warning}
        </Text>
      )}

      {detail.status === 'ok' && (
        <>
          <SessionHeader doc={detail.doc} now={generatedAt} />

          {detail.doc.source === 'issue-agent' &&
            detail.doc.transcriptGcsUri &&
            detail.transcript && (
              <Stack gap="sm">
                <Title order={2} size="h4">
                  Transcript
                </Title>
                <TranscriptTimelineView
                  events={detail.transcript.events}
                  warning={detail.transcript.warning}
                />
              </Stack>
            )}
        </>
      )}
    </Container>
  );
}
