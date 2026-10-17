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
import { formatDuration } from '../format';
import { RelativeTime } from '../relative-time';
import { SessionStatusLine } from '../session-status-line';

/**
 * One session laid out for a phone (below `sm`): the same row the table
 * shows, re-laid-out rather than truncated. Both branches render
 * unconditionally (CSS media queries via Mantine's visibleFrom/hiddenFrom).
 */
/** The table keeps a session on one row: its latest PRs, the rest counted.
 * A long-running CLI session can reference dozens; its page lists them all. */
const TABLE_PR_LIMIT = 3;

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

        {(row.model || row.resolvedModel) && (
          <Text size="xs" c="dimmed">
            {row.model ?? '—'}
            {row.resolvedModel ? ` → ${row.resolvedModel}` : ''}
          </Text>
        )}

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
                  {issueRef(row)}
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
                  PR #{latestPr.number}
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

/** The archive's columns, in order (design/fleet-console.html#sessions). */
export const SESSION_COLUMNS = [
  'Session',
  'Issue',
  'Agent',
  'Outcome',
  'Duration',
  'Tokens',
  'Started',
] as const;

/** Status tone for a session's liveness (status colour, never the accent). */
const LIVENESS_TONE: Record<SessionRow['liveness'], string> = {
  live: 'busy',
  idle: 'idle',
  ended: 'ok',
  stale: 'warn',
};

/** Compact token count for the archive's Tokens column ("1.11M", "88.2k"). */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function issueRef(row: SessionRow): string {
  return `${row.repo ? row.repo.name : ''}#${row.issueNumber}`;
}

/** The Session column's mono identifier: the run for a dispatched session,
 * the host for a CLI one, else the session id. */
function SessionRef({ row }: { row: SessionRow }) {
  if (row.source === 'issue-agent' && row.runId) {
    return row.runUrl ? (
      <Anchor
        href={row.runUrl}
        target="_blank"
        rel="noreferrer"
        className="session-ref"
      >
        run {row.runId} ↗
      </Anchor>
    ) : (
      <span className="session-ref">{row.runId}</span>
    );
  }
  if (row.source === 'cli' && row.host) {
    return <span className="session-ref">{row.host}</span>;
  }
  return <span className="session-ref">{row.sessionId.slice(0, 12)}</span>;
}

/**
 * The archive table as design/fleet-console.html#sessions draws it:
 * Session · Issue · Agent · Outcome · Duration · Tokens · Started. Model,
 * route, backend, turns and cost are the session's detail (FE-SE-3), one
 * click away on its row title. Below `sm` the same rows become cards.
 */
export function SessionTable({
  rows,
  fixedColumns = false,
}: {
  rows: SessionRow[];
  /** The by-issue view's group tables: fixed shared columns that fit the
   * panel rather than scrolling, so one header strip aligns with all. */
  fixedColumns?: boolean;
}) {
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
        minWidth={fixedColumns ? 0 : 820}
        visibleFrom="sm"
        className="sessions-table-scroll"
      >
        <Table
          highlightOnHover
          verticalSpacing="xs"
          fz="sm"
          className="sessions-table"
          style={{ width: '100%' }}
        >
          <colgroup>
            {SESSION_COLUMNS.map((column) => (
              <col key={column} />
            ))}
          </colgroup>
          <TableThead>
            <TableTr>
              {SESSION_COLUMNS.map((column, index) => (
                <TableTh
                  key={column}
                  className={index >= 4 ? 'sessions-table__num' : undefined}
                >
                  {column}
                </TableTh>
              ))}
            </TableTr>
          </TableThead>
          <TableTbody>
            {rows.map((row) => (
              <TableTr
                key={row.sessionId}
                data-testid={`session-row-${row.sessionId}`}
              >
                <TableTd className="sessions-table__session">
                  <Group gap={6} wrap="nowrap" className="session-ref-line">
                    <SourceBadge source={row.source} size="xs" />
                    <SessionRef row={row} />
                  </Group>
                  <Anchor
                    href={`/sessions/${row.sessionId}`}
                    size="sm"
                    truncate
                    className="session-title-link"
                    style={{ display: 'block' }}
                  >
                    {row.title}
                  </Anchor>
                  <SessionStatusLine
                    status={row.status}
                    statusUpdatedAt={row.statusUpdatedAt}
                    liveness={row.liveness}
                  />
                </TableTd>
                <TableTd>
                  {row.issueNumber !== undefined && row.issueUrl && (
                    <Anchor
                      href={row.issueUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="session-ref"
                      title="Open the issue on GitHub"
                    >
                      {issueRef(row)}
                    </Anchor>
                  )}
                </TableTd>
                <TableTd>
                  <AgentBadge agent={row.agent} />
                </TableTd>
                <TableTd>
                  <span
                    className="session-outcome"
                    data-tone={LIVENESS_TONE[row.liveness]}
                    data-testid="session-row-liveness"
                  >
                    {LIVENESS_LABELS[row.liveness]}
                  </span>
                  {row.prUrls.length > 0 && (
                    <Group gap={6} wrap="wrap" className="session-prs">
                      {row.prUrls.slice(-TABLE_PR_LIMIT).map((pr) => (
                        <Anchor
                          key={pr.number}
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                          className="session-ref"
                        >
                          PR #{pr.number}
                        </Anchor>
                      ))}
                      {row.prUrls.length > TABLE_PR_LIMIT && (
                        <Text span size="xs" c="dimmed">
                          +{row.prUrls.length - TABLE_PR_LIMIT} earlier
                        </Text>
                      )}
                    </Group>
                  )}
                </TableTd>
                <TableTd className="sessions-table__num">
                  {formatDuration(
                    sessionDurationSeconds(row.startedAt, row.lastActivityAt),
                  )}
                </TableTd>
                <TableTd
                  className="sessions-table__num"
                  title={`${row.totalTokens.toLocaleString('en-US')} cost-weighted tokens`}
                >
                  {formatTokenCount(row.totalTokens)}
                </TableTd>
                <TableTd className="sessions-table__num">
                  <RelativeTime iso={row.startedAt} variant="compact" />
                </TableTd>
              </TableTr>
            ))}
          </TableTbody>
        </Table>
      </TableScrollContainer>
    </>
  );
}
