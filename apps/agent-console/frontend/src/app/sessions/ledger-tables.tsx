import {
  Anchor,
  Group,
  Stack,
  Table,
  TableTbody,
  TableTd,
  TableTh,
  TableThead,
  TableTr,
  Text,
  Title,
} from '@mantine/core';

import { REPO_NAME, REPO_OWNER } from '../../lib/github-client';
import type {
  IssueLedgerRow,
  SessionLedger,
  WeekLedgerRow,
} from '../../lib/session-ledger';
import { formatCost } from '../format';

/** Each ledger is already fully sorted (cost desc, then tokens desc) by
 * aggregateSessionLedger - this just windows the display, since a busy
 * multi-week archive can have far more distinct issues/weeks than are
 * useful to show at once. */
const MAX_LEDGER_ROWS = 15;

function IssueLedgerTable({ rows }: { rows: IssueLedgerRow[] }) {
  return (
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
        {rows.slice(0, MAX_LEDGER_ROWS).map((row) => (
          <TableTr key={row.issueNumber} data-testid="ledger-issue-row">
            <TableTd>
              {row.issueNumber === 'no-issue' ? (
                <Text size="sm" c="dimmed">
                  no issue
                </Text>
              ) : (
                <Anchor
                  href={`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${row.issueNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  size="sm"
                >
                  #{row.issueNumber}
                </Anchor>
              )}
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
  );
}

function WeekLedgerTable({ rows }: { rows: WeekLedgerRow[] }) {
  return (
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
        {rows.slice(0, MAX_LEDGER_ROWS).map((row) => (
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

  return (
    <Stack gap="sm" mb="xl" data-testid="session-ledger">
      <Title order={2} size="h4">
        Cost ledger
      </Title>
      <Group align="flex-start" gap="xl" wrap="wrap">
        <Stack gap={4} style={{ flex: '1 1 320px' }}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            By issue
          </Text>
          <IssueLedgerTable rows={ledger.byIssue} />
        </Stack>
        <Stack gap={4} style={{ flex: '1 1 320px' }}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            By week
          </Text>
          <WeekLedgerTable rows={ledger.byWeek} />
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
