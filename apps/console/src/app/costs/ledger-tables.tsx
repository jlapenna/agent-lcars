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
} from '@mantine/core';

import { primaryWatchedRepo, repoItemKey } from '../../lib/github-client';
import type {
  IssueLedgerRow,
  LedgerTotals,
  SessionLedger,
  WeekLedgerRow,
} from '../../lib/session-ledger';
import { RepoBadge } from '../agent-activity-panel';
import { Eyebrow } from '../eyebrow';
import { formatCost } from '../format';

/** Cost cell contents for a ledger row - `~$1.23` when the total includes
 * at least one published-rate estimate (see LedgerTotals.costEstimated's
 * doc comment) rather than being entirely recorded costs, so a maintainer
 * doesn't mistake an estimate for a metered dollar figure at a glance. */
function CostCell({ row }: { row: LedgerTotals }) {
  if (row.costUsd === undefined) {
    return <>—</>;
  }
  return (
    <>
      {row.costEstimated ? '~' : ''}
      {formatCost(row.costUsd)}
    </>
  );
}

/** Each ledger is already fully sorted (cost desc, then tokens desc) by
 * aggregateSessionLedger - this just windows the display, since a busy
 * multi-week archive can have far more distinct issues/weeks than are
 * useful to show at once. */
const MAX_LEDGER_ROWS = 15;

/** Truthful footer for a windowed ledger - a capped list that looks
 * complete reads as "covered everything" when it is not. Renders nothing
 * while the window still fits. */
function TruncationNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <Text size="xs" c="dimmed" mt={4}>
      Showing {shown} of {total}
    </Text>
  );
}

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
    <Group
      gap={6}
      wrap="nowrap"
      className="costs-ledger-issue-identity"
      title={`${repo.owner}/${repo.name}`}
    >
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
 * `sm` and up: the full per-issue breakdown (Issue/Sessions/Turns/
 * Cost-weighted tokens/Cost), wrapped in its own scroll container (#3107) so an unusually wide
 * issue-number column can never push the page body sideways - unlike the
 * session table, this one rarely needs the scroll in practice at `sm`+
 * widths, but the container costs nothing when unused.
 */
function IssueLedgerTable({ rows }: { rows: IssueLedgerRow[] }) {
  return (
    <TableScrollContainer
      minWidth={360}
      visibleFrom="sm"
      className="costs-ledger-scroll"
    >
      <Table verticalSpacing="xs" fz="sm" className="costs-ledger-table">
        <TableThead>
          <TableTr>
            <TableTh>Issue</TableTh>
            <TableTh>Sessions</TableTh>
            <TableTh>Turns</TableTh>
            <TableTh>Cost-weighted tokens</TableTh>
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
                <CostCell row={row} />
              </TableTd>
            </TableTr>
          ))}
        </TableTbody>
      </Table>
    </TableScrollContainer>
  );
}

/**
 * Below `sm`: Turns/Cost-weighted tokens drop (both are one tap away on the
 * session table/detail page) so Issue/Sessions/Cost - what a maintainer
 * actually scans a budget ledger for on a phone, especially on the Costs
 * tab (#203: the compact table used to drop Cost itself, leaving no dollar
 * figure visible on mobile at all) - fits at 360px without the table
 * needing its own horizontal scroll at all. Still wrapped in a scroll
 * container defensively, since a long issue title... there isn't one here
 * (issue numbers are short), but an unexpectedly narrow viewport should
 * scroll the table, never the page.
 */
function IssueLedgerTableCompact({ rows }: { rows: IssueLedgerRow[] }) {
  return (
    <div
      className="costs-ledger-mobile-list"
      role="list"
      aria-label="Costs by issue"
    >
      {rows.map((row) => (
        <article
          key={issueRowKey(row)}
          className="costs-ledger-mobile-row"
          role="listitem"
          data-testid="ledger-issue-row-compact"
        >
          <div className="costs-ledger-mobile-row__primary">
            <div className="costs-ledger-mobile-row__identity">
              <IssueCell row={row} />
            </div>
            <Text size="xs" c="dimmed">
              {row.sessions} session{row.sessions === 1 ? '' : 's'}
            </Text>
          </div>
          <Text className="costs-ledger-mobile-row__cost">
            <CostCell row={row} />
          </Text>
        </article>
      ))}
    </div>
  );
}

function WeekLedgerTable({ rows }: { rows: WeekLedgerRow[] }) {
  return (
    <TableScrollContainer
      minWidth={360}
      visibleFrom="sm"
      className="costs-ledger-scroll"
    >
      <Table verticalSpacing="xs" fz="sm" className="costs-ledger-table">
        <TableThead>
          <TableTr>
            <TableTh>Week</TableTh>
            <TableTh>Sessions</TableTh>
            <TableTh>Turns</TableTh>
            <TableTh>Cost-weighted tokens</TableTh>
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
                <CostCell row={row} />
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
    <div
      className="costs-ledger-mobile-list"
      role="list"
      aria-label="Costs by week"
    >
      {rows.map((row) => (
        <article
          key={row.isoWeek}
          className="costs-ledger-mobile-row"
          role="listitem"
          data-testid="ledger-week-row-compact"
        >
          <div>
            <Text fw={600}>{row.isoWeek}</Text>
            <Text size="xs" c="dimmed">
              {row.sessions} session{row.sessions === 1 ? '' : 's'}
            </Text>
          </div>
          <Text className="costs-ledger-mobile-row__cost">
            <CostCell row={row} />
          </Text>
        </article>
      ))}
    </div>
  );
}

/**
 * The cost/token ledger for the session set currently in view - same data
 * as the table below it, just rolled up two ways (per issue, per ISO week)
 * so a maintainer can spot where budget is going without adding a session
 * up by hand. `costUsd` sums each bucket's sessions' recorded costs where
 * present, falling back to a published-rate estimate from model + tokens
 * otherwise (see session-ledger.ts's `docCost`) - a session with neither
 * (no model recorded, or an unrecognized one) still contributes nothing,
 * so a bucket mixing priced and unpriced sessions still shows a (partial)
 * total rather than an em-dash, called out by the footnote below rather
 * than tracked per-row. `~$…` (CostCell, driven by `costEstimated`) marks a
 * total that includes at least one estimate rather than being entirely
 * recorded costs.
 */
export function LedgerTables({ ledger }: { ledger: SessionLedger }) {
  if (ledger.byIssue.length === 0 && ledger.byWeek.length === 0) {
    return null;
  }

  const byIssue = ledger.byIssue.slice(0, MAX_LEDGER_ROWS);
  const byWeek = ledger.byWeek.slice(0, MAX_LEDGER_ROWS);

  return (
    <Stack gap={0} data-testid="session-ledger">
      <div className="costs-ledger-grid">
        <section className="costs-ledger-section" aria-labelledby="by-issue">
          <div className="costs-ledger-section__heading" id="by-issue">
            <Eyebrow>By issue</Eyebrow>
          </div>
          <IssueLedgerTable rows={byIssue} />
          <IssueLedgerTableCompact rows={byIssue} />
          <TruncationNote
            shown={byIssue.length}
            total={ledger.byIssue.length}
          />
        </section>
        <section className="costs-ledger-section" aria-labelledby="by-week">
          <div className="costs-ledger-section__heading" id="by-week">
            <Eyebrow>By week</Eyebrow>
          </div>
          <WeekLedgerTable rows={byWeek} />
          <WeekLedgerTableCompact rows={byWeek} />
          <TruncationNote shown={byWeek.length} total={ledger.byWeek.length} />
        </section>
      </div>
      <Text size="xs" c="dimmed" className="costs-ledger-note">
        Token totals include every session in view. Cost totals use each
        session&apos;s recorded cost where available, otherwise an estimate from
        published Claude API rates for its model and token usage (
        <code>~$…</code>); a session with no recorded cost and no recognized
        model is excluded, so a bucket mixing priced and unpriced sessions still
        shows a partial dollar figure.
      </Text>
    </Stack>
  );
}
