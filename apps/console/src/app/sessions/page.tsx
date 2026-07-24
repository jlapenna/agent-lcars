import { Container } from '@mantine/core';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import {
  getSessionArchive,
  parseSessionArchiveQuery,
} from '../../lib/session-archive';
import { ConsoleHeader } from '../console-header';
import { formatRelativeTime } from '../format';
import { LedgerTables } from './ledger-tables';
import { SessionTable } from './session-table';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    days?: string;
    source?: string;
    issue?: string;
  }>;
}

function describeWindow(query: {
  days: number;
  source?: string;
  issueNumber?: number;
}): string {
  const parts = [`last ${query.days} day${query.days === 1 ? '' : 's'}`];
  if (query.source) parts.push(`source=${query.source}`);
  if (query.issueNumber !== undefined)
    parts.push(`issue #${query.issueNumber}`);
  return parts.join(', ');
}

/**
 * The session archive: every CLI and issue-agent session (not just the last
 * 24h the dashboard shows), searchable by three plain query params
 * (`days`/`source`/`issue`) - deliberately no filter chrome beyond that
 * (#2694/#3019's "no speculative widgets" rule still applies here, even
 * though this route can otherwise be denser than the dashboard). Query
 * params are parsed defensively by parseSessionArchiveQuery; there's no form
 * to validate against, a maintainer edits the URL bar directly.
 */
export default async function SessionsPage({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const rawParams = await searchParams;
  const query = parseSessionArchiveQuery(rawParams);
  const { rows, ledger, warnings } = await getSessionArchive(query);

  const generatedAt = new Date().toISOString();

  return (
    <Container size="xl" py="xl">
      <ConsoleHeader
        current="sessions"
        title="Session Archive"
        subtitle={
          <>
            {describeWindow(query)} · {rows.length} session
            {rows.length === 1 ? '' : 's'}
          </>
        }
        generatedAt={generatedAt}
        refreshLabel={formatRelativeTime(generatedAt)}
        warnings={warnings}
      />

      <LedgerTables ledger={ledger} />

      <SessionTable rows={rows} />
    </Container>
  );
}
