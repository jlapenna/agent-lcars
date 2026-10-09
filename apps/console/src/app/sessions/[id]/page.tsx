import type { SessionDoc } from '@agent-lcars/telemetry';
import { Code, Stack, Text, Title } from '@mantine/core';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../../auth';
import { getWatchedRepos } from '../../../lib/github-client';
import type { QuickTaskSourceIdentity } from '../../../lib/quick-task-evidence';
import { getSessionDetail } from '../../../lib/session-detail';
import type { SessionTranscriptResult } from '../../../lib/session-transcript';
import { ConsoleCommandUtilities } from '../../console-command-utilities';
import { ConsoleFooter } from '../../console-footer';
import { repoScopedConsoleHrefs } from '../../console-hrefs';
import { NavPageLoading } from '../../page-loading';
import { withConsolePageShell } from '../../with-console-page-shell';
import { SessionHeader } from './session-header';
import { TranscriptTimelineView } from './transcript-timeline-view';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * The archive section renders supported capture-time transcripts, consented CLI
 * transcripts and separately archived OpenCode full exports. Unsupported formats
 * keep their URI note. Older OpenCode exports may predate the renderable flag;
 * the fetch result is used only alongside that explicit export capability.
 */
export function ArchivedSessionTranscript({
  doc,
  transcript,
}: {
  doc: SessionDoc;
  transcript?: SessionTranscriptResult;
}) {
  if (!doc.transcriptGcsUri) {
    if (doc.source !== 'cli') return null;
    const status = doc.cliTranscriptArchive?.status;
    const messages = {
      pending: 'Transcript archival enabled; waiting for the session to end.',
      failed:
        'Transcript unavailable (archive upload failed; the watcher will retry).',
      'too-large': 'Transcript unavailable (exceeds the 5 MiB archive limit).',
      expired: 'Transcript unavailable (archive retention expired).',
      unsupported:
        'Transcript unavailable (provider does not support console transcripts).',
      available: 'Transcript unavailable (archive reference missing).',
    };
    return (
      <Text size="sm" c="dimmed" data-testid="cli-transcript-state">
        {status
          ? messages[status]
          : 'Transcript archival not enabled for this CLI session.'}
      </Text>
    );
  }

  const agent = doc.agent;

  if (
    !doc.renderable &&
    !(doc.agent === 'opencode' && doc.resumeGcsUri && transcript)
  ) {
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

interface SessionDetailViewProps {
  detail: Awaited<ReturnType<typeof getSessionDetail>>;
  generatedAt: string;
  title: string;
  subtitle: string;
}

/** Session repository scope for the header's command cluster - factored out
 * since the desktop and mobile utility blocks both need it. */
function sessionRepoKey(
  detail: Awaited<ReturnType<typeof getSessionDetail>>,
): string | undefined {
  return detail.status === 'ok' && detail.doc.repo
    ? `${detail.doc.repo.owner}/${detail.doc.repo.name}`
    : undefined;
}

/** Quick task evidence identities for a session detail page - factored out
 * since the header's desktop and mobile utility blocks both need it. */
function sessionSourceIdentities(
  detail: Awaited<ReturnType<typeof getSessionDetail>>,
): QuickTaskSourceIdentity[] {
  if (detail.status !== 'ok') return [];
  const { doc } = detail;
  return [
    { label: 'Session' as const, value: doc.sessionId },
    ...(doc.source === 'issue-agent' && doc.repo && doc.runId
      ? [
          {
            label: 'Run' as const,
            value: `${doc.repo.owner}/${doc.repo.name}#${doc.runId}`,
          },
        ]
      : []),
    ...(doc.source === 'issue-agent' && doc.repo && doc.issueNumber
      ? [
          {
            label: 'Task' as const,
            value: `${doc.repo.owner}/${doc.repo.name}#${doc.issueNumber}`,
          },
        ]
      : []),
  ];
}

function SessionDetailViewContent({
  detail,
  generatedAt,
}: SessionDetailViewProps) {
  return (
    <>
      {detail.status === 'error' && (
        <Text size="sm" c="orange" mb="md" data-testid="session-detail-error">
          {detail.warning}
        </Text>
      )}

      {detail.status === 'ok' && (
        <>
          <SessionHeader doc={detail.doc} now={generatedAt} />

          <ArchivedSessionTranscript
            doc={detail.doc}
            transcript={detail.transcript}
          />
        </>
      )}
    </>
  );
}

const SessionDetailView = withConsolePageShell(
  SessionDetailViewContent,
  ({ detail, generatedAt, title, subtitle }) => ({
    current: 'sessions',
    title,
    subtitle,
    utilities: (
      <>
        <div className="session-detail-utilities session-detail-utilities--desktop console-utilities--desktop">
          <ConsoleCommandUtilities
            watchedRepos={getWatchedRepos()}
            initialRepoKey={sessionRepoKey(detail)}
            sourceIdentities={sessionSourceIdentities(detail)}
            generatedAt={generatedAt}
          />
        </div>
        <div className="session-detail-utilities session-detail-utilities--mobile console-utilities--mobile">
          <ConsoleCommandUtilities
            watchedRepos={getWatchedRepos()}
            initialRepoKey={sessionRepoKey(detail)}
            sourceIdentities={sessionSourceIdentities(detail)}
            includeNavigation
            navigationHrefs={repoScopedConsoleHrefs(sessionRepoKey(detail))}
          />
        </div>
      </>
    ),
    footer: <ConsoleFooter />,
  }),
);

/**
 * A single session's detail view: full header (identity, cost/token totals,
 * source-specific fields, deliverables, artifacts) plus - for a
 * session whose transcript was archived to GCS - the turn-by-
 * turn transcript timeline (or, for an unsupported agent's archive-first
 * stub, a note that it exists). A missing doc is a real 404; every other
 * failure mode (store read failure, GCS fetch/parse failure) fails soft to
 * a warning rather than a 500 - see session-detail.ts/session-transcript.ts
 * for where each of those is absorbed.
 */
async function SessionDetailPageContent({ params }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const { id } = await params;
  const detail = await getSessionDetail(id);

  if (detail.status === 'not-found') {
    notFound();
  }

  const generatedAt = new Date().toISOString();
  const title =
    detail.status === 'ok'
      ? (detail.doc.title ?? detail.doc.sessionId)
      : 'Session unavailable';
  const subtitle =
    detail.status === 'ok'
      ? `${detail.doc.source === 'issue-agent' ? 'Automation' : 'CLI'} session · ${detail.doc.sessionId}`
      : 'The session archive could not be read.';

  return (
    <SessionDetailView
      detail={detail}
      generatedAt={generatedAt}
      title={title}
      subtitle={subtitle}
    />
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, so the page body streams in behind 4-row placeholder rather
// than blocking the whole route on the GitHub/Firestore reads.
export default function SessionDetailPage({ params }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="sessions"
          title="Session detail"
          className="sessions-page-shell"
          rows={4}
        />
      }
    >
      <SessionDetailPageContent params={params} />
    </Suspense>
  );
}
