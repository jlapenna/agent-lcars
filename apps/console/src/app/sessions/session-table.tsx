import {
  Anchor,
  Badge,
  Card,
  Group,
  Stack,
  Table,
  TableScrollContainer,
  TableTbody,
  TableTd,
  TableTh,
  TableThead,
  TableTr,
  Text,
} from '@mantine/core';

import {
  sessionDurationSeconds,
  type SessionRow,
} from '../../lib/session-archive';
import {
  AgentBadge,
  LIVENESS_COLORS,
  LIVENESS_LABELS,
} from '../agent-activity-panel';
import { formatCost, formatDuration, formatRelativeTime } from '../format';

/**
 * The archive's dense session table - unlike the dashboard's In
 * Flight panel (agent-activity-panel.tsx), this route is explicitly a
 * history/search surface (#2694/#3019's "archive can be denser" carve-out),
 * so every session gets one row with every column rather than a curated
 * card. Reuses the same liveness badge styling as CliSessionRow for visual
 * consistency between the dashboard and the archive.
 *
 * Below `sm` (#3107), the 12-column table is unreadable without endless
 * horizontal swiping, so it's replaced entirely by one card per session
 * (`SessionCard` below) - same underlying rows, just re-laid-out for a
 * phone rather than truncated. Both branches render unconditionally (CSS
 * media queries via Mantine's visibleFrom/hiddenFrom, not JS), matching the
 * table/card-list split already used elsewhere in this repo (see e.g.
 * apps/primes/frontend's InvitesTable.tsx).
 */

/** Secondary fields that matter less than identity/status/links on a phone
 * - model, token volume, cost, and (CLI-only) host - folded into one muted
 * meta line rather than each getting card real estate. Host/Run's run link
 * is dropped entirely on the card: the card already links to the session
 * detail page, a more useful mobile-sized jump target than a bare Actions
 * run id. */
function sessionCardMeta(row: SessionRow): string {
  return [
    row.model,
    `${row.totalTokens.toLocaleString('en-US')} tok`,
    row.totalCostUsd !== undefined ? formatCost(row.totalCostUsd) : undefined,
    row.source === 'cli' ? row.host : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function SessionCard({ row }: { row: SessionRow }) {
  const meta = sessionCardMeta(row);
  return (
    <Card
      withBorder
      radius="md"
      padding="sm"
      data-testid={`session-card-${row.sessionId}`}
    >
      <Stack gap={6}>
        <Group justify="space-between" align="center" wrap="wrap" gap={6}>
          <Group gap={6} wrap="wrap">
            <Badge
              variant="outline"
              size="xs"
              color={row.source === 'cli' ? 'blue' : 'violet'}
            >
              {row.source === 'cli' ? 'cli' : 'agent'}
            </Badge>
            <AgentBadge agent={row.agent} />
          </Group>
          <Badge
            variant="light"
            size="xs"
            color={LIVENESS_COLORS[row.liveness]}
            data-testid="session-card-liveness"
          >
            {LIVENESS_LABELS[row.liveness]}
          </Badge>
        </Group>

        <Anchor
          href={`/sessions/${row.sessionId}`}
          size="sm"
          fw={500}
          truncate
          style={{ display: 'block' }}
        >
          {row.title}
        </Anchor>

        {(row.issueNumber !== undefined || row.prUrls.length > 0) && (
          <Group gap={10} wrap="wrap">
            {row.issueNumber !== undefined && row.issueUrl && (
              <Group gap={4} wrap="nowrap">
                <Text size="xs" c="dimmed">
                  issue
                </Text>
                <Anchor
                  href={row.issueUrl}
                  target="_blank"
                  rel="noreferrer"
                  size="xs"
                >
                  #{row.issueNumber}
                </Anchor>
              </Group>
            )}
            {row.prUrls.length > 0 && (
              <Group gap={4} wrap="wrap">
                <Text size="xs" c="dimmed">
                  {row.prUrls.length === 1 ? 'PR' : 'PRs'}
                </Text>
                {row.prUrls.map((pr) => (
                  <Anchor
                    key={pr.number}
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    size="xs"
                  >
                    #{pr.number}
                  </Anchor>
                ))}
              </Group>
            )}
          </Group>
        )}

        <Text size="xs" c="dimmed">
          {row.turns} turn{row.turns === 1 ? '' : 's'} · started{' '}
          {formatRelativeTime(row.startedAt)} ·{' '}
          {formatDuration(
            sessionDurationSeconds(row.startedAt, row.lastActivityAt),
          )}
        </Text>

        {meta && (
          <Text size="xs" c="dimmed" data-testid="session-card-meta">
            {meta}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

export function SessionTable({ rows }: { rows: SessionRow[] }) {
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="session-table-empty">
        No sessions in this window.
      </Text>
    );
  }

  return (
    <>
      <Stack gap="sm" hiddenFrom="sm" data-testid="session-cards">
        {rows.map((row) => (
          <SessionCard key={row.sessionId} row={row} />
        ))}
      </Stack>

      <TableScrollContainer minWidth={960} visibleFrom="sm">
        <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
          <TableThead>
            <TableTr>
              <TableTh>Source</TableTh>
              <TableTh>Session</TableTh>
              <TableTh>Issue</TableTh>
              <TableTh>PRs</TableTh>
              <TableTh>Host / Run</TableTh>
              <TableTh>Model</TableTh>
              <TableTh>Turns</TableTh>
              <TableTh>Tokens</TableTh>
              <TableTh>Cost</TableTh>
              <TableTh>Started</TableTh>
              <TableTh>Duration</TableTh>
              <TableTh>Status</TableTh>
            </TableTr>
          </TableThead>
          <TableTbody>
            {rows.map((row) => (
              <TableTr
                key={row.sessionId}
                data-testid={`session-row-${row.sessionId}`}
              >
                <TableTd>
                  <Badge
                    variant="outline"
                    size="xs"
                    color={row.source === 'cli' ? 'blue' : 'violet'}
                  >
                    {row.source === 'cli' ? 'cli' : 'agent'}
                  </Badge>
                </TableTd>
                <TableTd>
                  <Group gap={6} wrap="nowrap">
                    <Anchor
                      href={`/sessions/${row.sessionId}`}
                      size="sm"
                      truncate
                      style={{ maxWidth: 280, display: 'block' }}
                    >
                      {row.title}
                    </Anchor>
                    <AgentBadge agent={row.agent} />
                  </Group>
                </TableTd>
                <TableTd>
                  {row.issueNumber !== undefined && row.issueUrl && (
                    <Anchor
                      href={row.issueUrl}
                      target="_blank"
                      rel="noreferrer"
                      size="xs"
                    >
                      #{row.issueNumber}
                    </Anchor>
                  )}
                </TableTd>
                <TableTd>
                  {row.prUrls.map((pr) => (
                    <Anchor
                      key={pr.number}
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      size="xs"
                      mr={6}
                    >
                      #{pr.number}
                    </Anchor>
                  ))}
                </TableTd>
                <TableTd>
                  {row.source === 'cli' && row.host && (
                    <Text size="xs">{row.host}</Text>
                  )}
                  {row.source === 'issue-agent' && row.runUrl && (
                    <Anchor
                      href={row.runUrl}
                      target="_blank"
                      rel="noreferrer"
                      size="xs"
                    >
                      run ↗
                    </Anchor>
                  )}
                </TableTd>
                <TableTd>
                  <Text size="xs" c="dimmed">
                    {row.model ?? '—'}
                  </Text>
                </TableTd>
                <TableTd>{row.turns}</TableTd>
                <TableTd>{row.totalTokens.toLocaleString('en-US')}</TableTd>
                <TableTd>
                  {row.totalCostUsd !== undefined
                    ? formatCost(row.totalCostUsd)
                    : '—'}
                </TableTd>
                <TableTd>
                  <Text size="xs">{formatRelativeTime(row.startedAt)}</Text>
                </TableTd>
                <TableTd>
                  {formatDuration(
                    sessionDurationSeconds(row.startedAt, row.lastActivityAt),
                  )}
                </TableTd>
                <TableTd>
                  <Badge
                    variant="light"
                    size="xs"
                    color={LIVENESS_COLORS[row.liveness]}
                    data-testid="session-row-liveness"
                  >
                    {LIVENESS_LABELS[row.liveness]}
                  </Badge>
                </TableTd>
              </TableTr>
            ))}
          </TableTbody>
        </Table>
      </TableScrollContainer>
    </>
  );
}
