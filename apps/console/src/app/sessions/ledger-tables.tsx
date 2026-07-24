import {
  Anchor,
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
  Title,
} from '@mantine/core';

import { primaryWatchedRepo, repoItemKey } from '../../lib/github-client';
import type {
  IssueLedgerRow,
  SessionLedger,
  WeekLedgerRow,
} from '../../lib/session-ledger';
import { RepoBadge } from '../agent-activity-panel';
import { Eyebrow } from '../eyebrow';
import { formatCost } from '../format';

/** Each ledger is already fully sorted (cost desc, then tokens desc) by
 * aggregateSessionLedger - this just windows the display, since a busy
 * multi-week archive can have far more distinct issues/weeks than are
 * useful to show at once. */
const MAX_LEDGER_ROWS = 15;

/** React key for an issue-ledger row - the bare issue number collides once
 * two watched repos can each have their own #42 (same class of bug Codex
 * caught in the board's row keys, #18); 'no-issue' is already a unique
 * literal on its own, so it's returned as-is. */
function issueRowKey(row: IssueLedgerRow): string | number {
  return row.issueNumber === 'no-issue'
    ? row.issueNumber
    : repoItemKey(row.repo ?? primaryWatchedRepo(), row.issueNumber);
}

function IssueCell({ row }: { row: IssueLedgerRow }) {
  if (row.issueNumber === 'no-issue') {
    return (
      <Text size="sm" c="dimmed">
        no issue
      </Text>
    );
  }
  // row.repo is only absent for the 'no-issue' catch-all (handled above) -
  // every real issueNumber row carries one, already resolved against
  // primaryWatchedRepo() by aggregateSessionLedger for docs predating
  // Phase 0's `repo` field. Kept here too as a type-safe fallback.
  const repo = row.repo ?? primaryWatchedRepo();
  return (
    <Group gap={6} wrap="nowrap">
      <Anchor
        href={`https://github.com/${repo.owner}/${repo.name}/issues/${row.issueNumber}`}
        target="_blank"
        rel="noreferrer"
        size="sm"
      >
        #{row.issueNumber}
      </Anchor>
      <RepoBadge repo={repo} />
    </Group>
  );
}

/**
 * `sm` and up: the full per-issue breakdown (Issue/Sessions/Turns/Tokens/
 * Cost), wrapped in its own scroll container (#3107) so an unusually wide
 * issue-number column can never push the page body sideways - unlike the
 * session table, this one rarely needs the scroll in practice at `sm`+
 * widths, but the container costs nothing when unused.
 */
function IssueLedgerTable({ rows }: { rows: IssueLedgerRow[] }) {
  return (
    <TableScrollContainer minWidth={360} visibleFrom="sm">
      <Table verticalSpacing="xs" fz="sm">
        <TableThead>
          <TableTr>
            <TableTh>Issue</TableTh>
            <TableTh>Sessions</TableTh>
            <TableTh>Turns</TableTh>
            <TableTh>Tokens</TableTh>
            <TableTh>Cost</TableTh>
          </TableTr>
        </TableThead>
        <TableTbody>
          {rows.map((row) => (
            <TableTr key={issueRowKey(row)} data-testid="ledger-issue-row">
              <TableTd>
                <IssueCell row={row} />
              </TableTd>
              <TableTd>{row.sessions}</TableTd>
              <TableTd>{row.turns}</TableTd>
              <TableTd>{row.tokens.toLocaleString('en-US')}</TableTd>
              <TableTd>
                {row.costUsd !== undefined ? formatCost(row.costUsd) : '—'}
              </TableTd>
            </TableTr>
          ))}
        </TableTbody>
      </Table>
    </TableScrollContainer>
  );
}

/**
 * Below `sm`: Turns/Cost drop (both are one tap away on the session
 * table/detail page) so Issue/Sessions/Tokens - what a maintainer actually
 * scans a budget ledger for on a phone - fits at 360px without the table
 * needing its own horizontal scroll at all. Still wrapped in a scroll
 * container defensively, since a long issue title... there isn't one here
 * (issue numbers are short), but an unexpectedly narrow viewport should
 * scroll the table, never the page.
 */
function IssueLedgerTableCompact({ rows }: { rows: IssueLedgerRow[] }) {
  return (
    <TableScrollContainer minWidth={240} hiddenFrom="sm">
      <Table verticalSpacing="xs" fz="sm">
        <TableThead>
          <TableTr>
            <TableTh>Issue</TableTh>
            <TableTh>Sessions</TableTh>
            <TableTh>Tokens</TableTh>
          </TableTr>
        </TableThead>
        <TableTbody>
          {rows.map((row) => (
            <TableTr
              key={issueRowKey(row)}
              data-testid="ledger-issue-row-compact"
            >
              <TableTd>
                <IssueCell row={row} />
              </TableTd>
              <TableTd>{row.sessions}</TableTd>
              <TableTd>{row.tokens.toLocaleString('en-US')}</TableTd>
            </TableTr>
          ))}
        </TableTbody>
      </Table>
    </TableScrollContainer>
  );
}

function WeekLedgerTable({ rows }: { rows: WeekLedgerRow[] }) {
  return (
    <TableScrollContainer minWidth={360} visibleFrom="sm">
      <Table verticalSpacing="xs" fz="sm">
        <TableThead>
          <TableTr>
            <TableTh>Week</TableTh>
            <TableTh>Sessions</TableTh>
            <TableTh>Turns</TableTh>
            <TableTh>Tokens</TableTh>
            <TableTh>Cost</TableTh>
          </TableTr>
        </TableThead>
        <TableTbody>
          {rows.map((row) => (
            <TableTr key={row.isoWeek} data-testid="ledger-week-row">
              <TableTd>{row.isoWeek}</TableTd>
              <TableTd>{row.sessions}</TableTd>
              <TableTd>{row.turns}</TableTd>
              <TableTd>{row.tokens.toLocaleString('en-US')}</TableTd>
              <TableTd>
                {row.costUsd !== undefined ? formatCost(row.costUsd) : '—'}
              </TableTd>
            </TableTr>
          ))}
        </TableTbody>
      </Table>
    </TableScrollContainer>
  );
}

function WeekLedgerTableCompact({ rows }: { rows: WeekLedgerRow[] }) {
  return (
    <TableScrollContainer minWidth={240} hiddenFrom="sm">
      <Table verticalSpacing="xs" fz="sm">
        <TableThead>
          <TableTr>
            <TableTh>Week</TableTh>
            <TableTh>Sessions</TableTh>
            <TableTh>Tokens</TableTh>
          </TableTr>
        </TableThead>
        <TableTbody>
          {rows.map((row) => (
            <TableTr key={row.isoWeek} data-testid="ledger-week-row-compact">
              <TableTd>{row.isoWeek}</TableTd>
              <TableTd>{row.sessions}</TableTd>
              <TableTd>{row.tokens.toLocaleString('en-US')}</TableTd>
            </TableTr>
          ))}
        </TableTbody>
      </Table>
    </TableScrollContainer>
  );
}

/**
 * The cost/token ledger for the session set currently in view - same data
 * as the table below it, just rolled up two ways (per issue, per ISO week)
 * so a maintainer can spot where budget is going without adding a session
 * up by hand. `costUsd` is a real dollar total, but only across the
 * sessions in a bucket that recorded one - a bucket mixing costed and
 * uncosted sessions still shows a (partial) total rather than an em-dash,
 * called out by the footnote below rather than tracked per-row (see
 * session-ledger.ts's LedgerTotals doc comment for why that tradeoff is
 * made at aggregation time, not render time).
 */
export function LedgerTables({ ledger }: { ledger: SessionLedger }) {
  if (ledger.byIssue.length === 0 && ledger.byWeek.length === 0) {
    return null;
  }

  const byIssue = ledger.byIssue.slice(0, MAX_LEDGER_ROWS);
  const byWeek = ledger.byWeek.slice(0, MAX_LEDGER_ROWS);

  return (
    <Stack gap="sm" mb="xl" data-testid="session-ledger">
      <Title order={2} size="h4">
        Cost ledger
      </Title>
      <Group align="flex-start" gap="xl" wrap="wrap">
        <Stack gap={4} style={{ flex: '1 1 320px' }}>
          <Eyebrow>By issue</Eyebrow>
          <IssueLedgerTable rows={byIssue} />
          <IssueLedgerTableCompact rows={byIssue} />
        </Stack>
        <Stack gap={4} style={{ flex: '1 1 320px' }}>
          <Eyebrow>By week</Eyebrow>
          <WeekLedgerTable rows={byWeek} />
          <WeekLedgerTableCompact rows={byWeek} />
        </Stack>
      </Group>
      <Text size="xs" c="dimmed">
        Token totals include every session in view; cost totals include only
        sessions with a recorded cost, so a bucket mixing measured and
        unmeasured sessions still shows a partial dollar figure.
      </Text>
    </Stack>
  );
}
