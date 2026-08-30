import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { isSessionRenderable, sessionAgent } from '@agent-lcars/telemetry';
import { Code, Stack, Text, Title } from '@mantine/core';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../../auth';
import { consoleRepositoryUrl } from '../../../lib/deployment';
import { getWatchedRepos } from '../../../lib/github-client';
import { getSessionDetail } from '../../../lib/session-detail';
import type { SessionTranscriptResult } from '../../../lib/session-transcript';
import { ConsoleFooter } from '../../console-footer';
import { repoScopedConsoleHrefs } from '../../console-hrefs';
import { formatRelativeTime } from '../../format';
import { NavPageLoading } from '../../page-loading';
import { QueueUtilityMenu } from '../../queue-utility-menu';
import { QuickTaskButton } from '../../quick-task-button';
import { RefreshButton } from '../../refresh-button';
import { SignOutButton } from '../../sign-out-button';
import { withConsolePageShell } from '../../with-console-page-shell';
import { SessionHeader } from './session-header';
import { TranscriptTimelineView } from './transcript-timeline-view';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * The bottom half of an issue-agent session's detail view: either the real
 * turn-by-turn transcript timeline (`isSessionRenderable(doc)`, see
 * `transcript-timeline.ts`'s `RENDERABLE_TRANSCRIPT_AGENTS`), or - for every
 * unsupported agent - a short note that the archive exists without attempting to
 * render it as a transcript. Rendering the latter as a transcript would
 * fail-soft into a scary warning on every one of those session pages for no
 * benefit, since an archive-first agent's raw shape may not even be one file
 * (see `types.ts`'s
 * `transcriptGcsUri` doc comment). This reads the same `renderable` field
 * `session-detail.ts`'s fetch gate does rather than re-deriving its own
 * opinion from `sessionAgent(doc)` - agent-lcars#645's Bug 3 was exactly two
 * call sites disagreeing about how to answer this question. Exported (not
 * inlined into the page below) so both branches are independently
 * unit-testable without rendering the whole async server page.
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

  if (!isSessionRenderable(doc)) {
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

          {detail.doc.source === 'issue-agent' && (
            <ArchivedSessionTranscript
              doc={detail.doc}
              transcript={detail.transcript}
            />
          )}
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
        <div className="session-detail-utilities session-detail-utilities--desktop">
          <RefreshButton
            generatedAt={generatedAt}
            initialLabel={formatRelativeTime(generatedAt)}
          />
        </div>
        <div className="session-detail-utilities session-detail-utilities--mobile">
          <RefreshButton
            generatedAt={generatedAt}
            initialLabel={formatRelativeTime(generatedAt)}
            compact
          />
          <QueueUtilityMenu
            repositoryUrl={consoleRepositoryUrl()}
            includeNavigation
            navigationHrefs={repoScopedConsoleHrefs(
              detail.status === 'ok' && detail.doc.repo
                ? `${detail.doc.repo.owner}/${detail.doc.repo.name}`
                : undefined,
            )}
            signOutControl={<SignOutButton />}
          />
        </div>
      </>
    ),
    footer: (
      <ConsoleFooter
        actions={
          <QuickTaskButton
            watchedRepos={getWatchedRepos()}
            initialRepoKey={
              detail.status === 'ok' && detail.doc.repo
                ? `${detail.doc.repo.owner}/${detail.doc.repo.name}`
                : undefined
            }
            sourceIdentities={
              detail.status === 'ok'
                ? [
                    {
                      label: 'Session' as const,
                      value: detail.doc.sessionId,
                    },
                    ...(detail.doc.source === 'issue-agent' &&
                    detail.doc.repo &&
                    detail.doc.runId
                      ? [
                          {
                            label: 'Run' as const,
                            value: `${detail.doc.repo.owner}/${detail.doc.repo.name}#${detail.doc.runId}`,
                          },
                        ]
                      : []),
                    ...(detail.doc.source === 'issue-agent' &&
                    detail.doc.repo &&
                    detail.doc.issueNumber
                      ? [
                          {
                            label: 'Task' as const,
                            value: `${detail.doc.repo.owner}/${detail.doc.repo.name}#${detail.doc.issueNumber}`,
                          },
                        ]
                      : []),
                  ]
                : []
            }
          />
        }
      />
    ),
  }),
);

/**
 * A single session's detail view: full header (identity, cost/token totals,
 * source-specific fields, deliverables, artifacts) plus - for an
 * issue-agent session whose transcript was archived to GCS - the turn-by-
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
