import {
  Anchor,
  Badge,
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
import { LIVENESS_COLORS, LIVENESS_LABELS } from '../agent-activity-panel';
import { formatCost, formatDuration, formatRelativeTime } from '../format';

/**
 * The archive's dense session table - unlike the dashboard's In
 * Flight panel (agent-activity-panel.tsx), this route is explicitly a
 * history/search surface (#2694/#3019's "archive can be denser" carve-out),
 * so every session gets one row with every column rather than a curated
 * card. Reuses the same liveness badge styling as CliSessionRow for visual
 * consistency between the dashboard and the archive.
 */
export function SessionTable({ rows }: { rows: SessionRow[] }) {
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="session-table-empty">
        No sessions in this window.
      </Text>
    );
  }

  return (
    <TableScrollContainer minWidth={960}>
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
                <Anchor
                  href={`/sessions/${row.sessionId}`}
                  size="sm"
                  truncate
                  style={{ maxWidth: 280, display: 'block' }}
                >
                  {row.title}
                </Anchor>
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
  );
}
