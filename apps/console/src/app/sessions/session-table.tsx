import {
  Anchor,
  Badge,
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
  RepoBadge,
  SourceBadge,
} from '../agent-activity-panel';
import { formatCost, formatDuration } from '../format';
import { RelativeTime } from '../relative-time';
import { SessionStatusLine } from '../session-status-line';

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
 * media queries via Mantine's visibleFrom/hiddenFrom, not JS).
 */

function SessionCard({ row }: { row: SessionRow }) {
  const latestPr = row.prUrls.at(-1);
  const earlierPrCount = Math.max(0, row.prUrls.length - 1);
  return (
    <article
      className="session-mobile-row"
      data-testid={`session-card-${row.sessionId}`}
    >
      <Stack gap={6}>
        <Group justify="space-between" align="center" wrap="wrap" gap={6}>
          <Group gap={6} wrap="wrap">
            <SourceBadge source={row.source} size="xs" />
            <AgentBadge agent={row.agent} />
            {row.repo && <RepoBadge repo={row.repo} />}
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
          className="session-title-link session-card__title"
          style={{ display: 'block' }}
        >
          <Text component="span" inherit lineClamp={2}>
            {row.title}
          </Text>
        </Anchor>

        <SessionStatusLine
          status={row.status}
          statusUpdatedAt={row.statusUpdatedAt}
          liveness={row.liveness}
        />

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
            {latestPr && (
              <Group gap={4} wrap="wrap">
                <Text size="xs" c="dimmed">
                  PR
                </Text>
                <Anchor
                  href={latestPr.url}
                  target="_blank"
                  rel="noreferrer"
                  size="xs"
                >
                  #{latestPr.number}
                </Anchor>
                {earlierPrCount > 0 && (
                  <Text size="xs" c="dimmed">
                    +{earlierPrCount} earlier
                  </Text>
                )}
              </Group>
            )}
          </Group>
        )}

        <Text size="xs" c="dimmed">
          Last active <RelativeTime iso={row.lastActivityAt} /> · {row.turns}{' '}
          turn{row.turns === 1 ? '' : 's'} ·{' '}
          {formatDuration(
            sessionDurationSeconds(row.startedAt, row.lastActivityAt),
          )}
        </Text>
      </Stack>
    </article>
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
      <Stack gap={0} hiddenFrom="sm" data-testid="session-cards">
        {rows.map((row) => (
          <SessionCard key={row.sessionId} row={row} />
        ))}
      </Stack>

      <TableScrollContainer
        minWidth={960}
        visibleFrom="sm"
        className="sessions-table-scroll"
      >
        <Table
          striped
          highlightOnHover
          verticalSpacing="xs"
          fz="sm"
          className="sessions-table"
          style={{ width: '100%' }}
        >
          <TableThead>
            <TableTr>
              <TableTh>Source</TableTh>
              <TableTh>Session</TableTh>
              <TableTh>Issue</TableTh>
              <TableTh>PRs</TableTh>
              <TableTh>Host / Run</TableTh>
              <TableTh>Model</TableTh>
              <TableTh>Turns</TableTh>
              <TableTh>Cost-weighted tokens</TableTh>
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
                  <SourceBadge source={row.source} size="xs" />
                </TableTd>
                <TableTd style={{ maxWidth: 280 }}>
                  <Stack gap={2}>
                    <Group gap={6} wrap="nowrap">
                      <Anchor
                        href={`/sessions/${row.sessionId}`}
                        size="sm"
                        truncate
                        className="session-title-link"
                        style={{ maxWidth: 280, display: 'block' }}
                      >
                        {row.title}
                      </Anchor>
                      <AgentBadge agent={row.agent} />
                      {row.repo && <RepoBadge repo={row.repo} />}
                    </Group>
                    <SessionStatusLine
                      status={row.status}
                      statusUpdatedAt={row.statusUpdatedAt}
                      liveness={row.liveness}
                    />
                  </Stack>
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
                  {row.source === 'issue-agent' &&
                    row.runId &&
                    (row.runUrl ? (
                      <Anchor
                        href={row.runUrl}
                        target="_blank"
                        rel="noreferrer"
                        size="xs"
                      >
                        run ↗
                      </Anchor>
                    ) : (
                      <Text size="xs">{row.runId}</Text>
                    ))}
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
                  <Text size="xs">
                    <RelativeTime iso={row.startedAt} />
                  </Text>
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
