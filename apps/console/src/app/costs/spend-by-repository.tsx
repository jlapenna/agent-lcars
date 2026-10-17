import {
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
  Title,
} from '@mantine/core';

import type { RepositorySpend } from '../../lib/session-spend-by-repo';
import { formatCost } from '../format';

function money(usd: number | undefined, estimated = false): string {
  if (usd === undefined) return '—';
  return `${formatCost(usd)}${estimated ? ' est.' : ''}`;
}

/**
 * "Spend by repository" (design/fleet-console.html#costs): today and
 * seven-day known spend per repository, the seven-day share as a meter, the
 * session count and the spend per session. Seven-day figures are withheld,
 * not undercounted, when the selected window is shorter than seven days.
 */
/** `owner/name`, breakable after the slash rather than mid-word. */
function RepoName({ repo }: { repo: string }) {
  const slash = repo.indexOf('/');
  if (slash < 0) return <>{repo}</>;
  return (
    <>
      {repo.slice(0, slash + 1)}
      <wbr />
      {repo.slice(slash + 1)}
    </>
  );
}

type RepositoryRow = RepositorySpend['rows'][number];

/** The seven-day share as a meter beside its amount. */
function SevenDayBar({ row, max }: { row: RepositoryRow; max: number }) {
  const share = max > 0 ? (row.sevenDayUsd / max) * 100 : 0;
  return (
    <div className="costs-repo-spend__bar">
      <div
        className="costs-repo-spend__meter"
        role="img"
        aria-label={`${Math.round(share)}% of the largest repository`}
      >
        <i style={{ width: `${share}%` }} />
      </div>
      <span>{money(row.sevenDayUsd, row.estimated)}</span>
    </div>
  );
}

export function SpendByRepository({ spend }: { spend: RepositorySpend }) {
  const max = Math.max(0, ...spend.rows.map((row) => row.sevenDayUsd));
  const unavailable = spend.sevenDayUnavailable;
  return (
    <Card
      withBorder
      className="lcars-panel costs-repo-spend"
      data-testid="spend-by-repository"
    >
      <Group
        gap={10}
        align="baseline"
        wrap="nowrap"
        className="costs-repo-spend__head"
      >
        <Title order={2}>Spend by repository</Title>
        <span className="costs-repo-spend__count">
          {spend.todayUnavailable ? '—' : money(spend.todayUsd)} today
        </span>
        <span className="costs-repo-spend__meta">
          {spend.todayUnavailable
            ? 'today unavailable · window under 1 day · '
            : ''}
          {unavailable
            ? '7-day total unavailable · window under 7 days'
            : `7-day total ${money(spend.sevenDayUsd)}`}{' '}
          · UTC day
        </span>
      </Group>
      {spend.rows.length === 0 ? (
        <Text c="dimmed" size="sm" py="sm">
          No sessions with activity in the last seven days.
        </Text>
      ) : (
        <TableScrollContainer minWidth={560} visibleFrom="sm">
          <Table highlightOnHover verticalSpacing="xs" fz="sm">
            <TableThead>
              <TableTr>
                <TableTh>Repository</TableTh>
                <TableTh className="costs-repo-spend__num">Today</TableTh>
                <TableTh>7 days</TableTh>
                <TableTh className="costs-repo-spend__num">
                  Sessions · 7d
                </TableTh>
                <TableTh className="costs-repo-spend__num">Per session</TableTh>
              </TableTr>
            </TableThead>
            <TableTbody>
              {spend.rows.map((row) => (
                <TableTr key={row.repo} data-testid={`repo-spend-${row.repo}`}>
                  <TableTd className="costs-repo-spend__repo">
                    <RepoName repo={row.repo} />
                  </TableTd>
                  <TableTd className="costs-repo-spend__num">
                    {spend.todayUnavailable
                      ? '—'
                      : money(row.todayUsd, row.estimated)}
                  </TableTd>
                  <TableTd className="costs-repo-spend__week">
                    {unavailable ? '—' : <SevenDayBar row={row} max={max} />}
                  </TableTd>
                  <TableTd className="costs-repo-spend__num">
                    {unavailable ? '—' : row.sessions7d}
                    {!unavailable && row.unpriced > 0 && (
                      <Text span size="xs" c="dimmed">
                        {' '}
                        ({row.unpriced} unpriced)
                      </Text>
                    )}
                  </TableTd>
                  <TableTd className="costs-repo-spend__num">
                    {unavailable
                      ? '—'
                      : money(row.perSessionUsd, row.estimated)}
                  </TableTd>
                </TableTr>
              ))}
            </TableTbody>
          </Table>
        </TableScrollContainer>
      )}
      {spend.rows.length > 0 && (
        <Stack
          gap={0}
          hiddenFrom="sm"
          role="list"
          aria-label="Spend by repository"
          className="costs-repo-spend__cards"
        >
          {spend.rows.map((row) => (
            <article
              key={row.repo}
              role="listitem"
              className="costs-repo-spend__card"
            >
              <span className="costs-repo-spend__repo">
                <RepoName repo={row.repo} />
              </span>
              {unavailable ? null : <SevenDayBar row={row} max={max} />}
              <Text size="xs" c="dimmed">
                today{' '}
                {spend.todayUnavailable
                  ? '—'
                  : money(row.todayUsd, row.estimated)}
                {unavailable
                  ? ' · seven-day figures unavailable'
                  : ` · ${row.sessions7d} sessions${row.unpriced > 0 ? ` (${row.unpriced} unpriced)` : ''} · ${money(row.perSessionUsd, row.estimated)} / session`}
              </Text>
            </article>
          ))}
        </Stack>
      )}
    </Card>
  );
}
