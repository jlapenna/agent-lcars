import { Anchor, Container, Group, Stack, Text, Title } from '@mantine/core';
import { assertAdmin } from '@repo/auth/server';

import { auth } from '../../auth';
import {
  getSessionArchive,
  parseSessionArchiveQuery,
} from '../../lib/session-archive';
import { formatRelativeTime } from '../format';
import { RefreshButton } from '../refresh-button';
import { ThemeToggle } from '../theme-toggle';
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
      <Group justify="space-between" align="flex-start" gap="sm" mb="xl">
        <div>
          <Title order={1}>Session Archive</Title>
          <Text c="dimmed" mt={4}>
            {describeWindow(query)} · {rows.length} session
            {rows.length === 1 ? '' : 's'}
          </Text>
        </div>
        <Group gap="sm">
          <Anchor href="/" size="sm">
            ← Task queue
          </Anchor>
          <Anchor href="/agents" size="sm">
            Agent status →
          </Anchor>
          <RefreshButton
            generatedAt={generatedAt}
            initialLabel={formatRelativeTime(generatedAt)}
          />
          <ThemeToggle size="lg" />
        </Group>
      </Group>

      {warnings.length > 0 && (
        <details data-testid="data-warnings" style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer' }}>
            <Text size="sm" c="yellow" component="span">
              ⚠ {warnings.length} data warning
              {warnings.length === 1 ? '' : 's'} — some sections may be
              incomplete
            </Text>
          </summary>
          <Stack gap={4} mt="xs">
            {warnings.map((warning) => (
              <Text key={warning} size="xs" c="dimmed">
                {warning}
              </Text>
            ))}
          </Stack>
        </details>
      )}

      <LedgerTables ledger={ledger} />

      <SessionTable rows={rows} />
    </Container>
  );
}
