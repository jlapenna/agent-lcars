import {
  Anchor,
  Code,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { IssueAgentSessionDoc } from '@repo/agent-telemetry';
import { sessionAgent } from '@repo/agent-telemetry';
import { assertAdmin } from '@repo/auth/server';
import { notFound } from 'next/navigation';

import { auth } from '../../../auth';
import { getSessionDetail } from '../../../lib/session-detail';
import type { SessionTranscriptResult } from '../../../lib/session-transcript';
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
 * The bottom half of an issue-agent session's detail view: either the real
 * turn-by-turn transcript timeline (`sessionAgent(doc) === 'claude-code'`,
 * the only agent with a working transcript reducer today - see
 * `transcript-adapter.ts`'s seam), or - for every other agent's
 * archive-first stub session (#3123 phase 2, e.g. opencode.yml's "Ship
 * session archive" step) - a short note that the archive exists without
 * attempting to render it as a transcript. Rendering the latter as a
 * transcript would fail-soft into a scary warning on every one of those
 * session pages for no benefit, since `getSessionTranscript` only knows how
 * to parse a single Claude Code `.jsonl` object, not a non-Claude archive
 * (which may not even be one file - see `types.ts`'s `transcriptGcsUri` doc
 * comment). Exported (not inlined into the page below) so both branches are
 * independently unit-testable without rendering the whole async server page.
 */
export function ArchivedSessionTranscript({
  doc,
  transcript,
}: {
  doc: IssueAgentSessionDoc;
  transcript?: SessionTranscriptResult;
}) {
  if (!doc.transcriptGcsUri) {
    return null;
  }

  const agent = sessionAgent(doc);

  if (agent !== 'claude-code') {
    return (
      <Stack gap={4} data-testid="session-archive-note">
        <Text size="sm" c="dimmed">
          Session archive stored ({agent} format) — not yet renderable
        </Text>
        <Code
          data-testid="session-archive-uri"
          style={{ overflowX: 'auto', whiteSpace: 'nowrap' }}
        >
          {doc.transcriptGcsUri}
        </Code>
      </Stack>
    );
  }

  if (!transcript) {
    return null;
  }

  return (
    <Stack gap="sm">
      <Title order={2} size="h4">
        Transcript
      </Title>
      <TranscriptTimelineView
        events={transcript.events}
        warning={transcript.warning}
      />
    </Stack>
  );
}

/**
 * A single session's detail view: full header (identity, cost/token totals,
 * source-specific fields, deliverables, artifacts) plus - for an
 * issue-agent session whose transcript was archived to GCS - the turn-by-
 * turn transcript timeline (or, for a non-Claude-Code agent's archive-first
 * stub, a note that it exists). A missing doc is a real 404; every other
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

          {detail.doc.source === 'issue-agent' && (
            <ArchivedSessionTranscript
              doc={detail.doc}
              transcript={detail.transcript}
            />
          )}
        </>
      )}
    </Container>
  );
}
