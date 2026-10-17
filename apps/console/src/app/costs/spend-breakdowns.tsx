import {
  Anchor,
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
  assessCostBudget,
  type CostBudget,
  type SessionSpend,
  type SpendBreakdown,
} from '../../lib/session-spend';
import { formatCost } from '../format';
import { OpsPanel } from '../ops-primitives';

const money = (value: number | undefined) =>
  value === undefined ? '—' : formatCost(value);

function Breakdown({
  title,
  label,
  rows,
}: {
  title: string;
  /** The identity column's header: what one row is. */
  label: string;
  rows: SpendBreakdown[];
}) {
  const shown = rows.slice(0, 15);
  return (
    <OpsPanel
      title={title}
      count={rows.length}
      meta="reported · estimated · per merged PR"
      className="costs-ledger-section"
      aria-label={title}
    >
      <TableScrollContainer
        minWidth={600}
        visibleFrom="sm"
        className="costs-ledger-scroll"
      >
        <Table verticalSpacing="xs" fz="sm" className="costs-ledger-table">
          <TableThead>
            <TableTr>
              <TableTh>{label}</TableTh>
              <TableTh>Sessions</TableTh>
              <TableTh>Reported</TableTh>
              <TableTh>Estimated</TableTh>
              <TableTh>Unpriced</TableTh>
              <TableTh>Merged PRs</TableTh>
              <TableTh>Cost / merged PR</TableTh>
            </TableTr>
          </TableThead>
          <TableTbody>
            {shown.map((row) => (
              <TableTr key={row.key}>
                <TableTd>
                  <span className="costs-spend-identity">{row.key}</span>
                </TableTd>
                <TableTd>{row.sessions}</TableTd>
                <TableTd>{money(row.reportedCostUsd)}</TableTd>
                <TableTd>{money(row.estimatedCostUsd)}</TableTd>
                <TableTd>{row.unpricedSessions}</TableTd>
                <TableTd>
                  {row.mergedPRs}
                  {row.unknownPRs || row.unqualifiedPRReferences ? (
                    <span className="costs-ledger-table__aside">
                      {' '}
                      · {row.unknownPRs} unknown · {row.unqualifiedPRReferences}{' '}
                      unqualified
                    </span>
                  ) : null}
                </TableTd>
                <TableTd>
                  {money(row.costPerMergedDeliverableUsd)}
                  {row.costEstimated ? ' est.' : ''}
                  {row.unpricedSessions ||
                  row.unknownPRs ||
                  row.unqualifiedPRReferences
                    ? ' partial'
                    : ''}
                </TableTd>
              </TableTr>
            ))}
          </TableTbody>
        </Table>
      </TableScrollContainer>
      <div className="costs-ledger-mobile-list" role="list" aria-label={title}>
        {shown.map((row) => (
          <article
            key={row.key}
            className="costs-ledger-mobile-row"
            role="listitem"
          >
            <div className="costs-ledger-mobile-row__primary">
              <Text fw={600} className="costs-spend-identity">
                {row.key}
              </Text>
              <Text size="xs" c="dimmed">
                {row.sessions} sessions · reported {money(row.reportedCostUsd)}{' '}
                · estimated {money(row.estimatedCostUsd)} ·{' '}
                {row.unpricedSessions} unpriced
              </Text>
              <Text size="xs" c="dimmed">
                {row.mergedPRs} merged PRs · {row.unknownPRs} unknown ·{' '}
                {row.unqualifiedPRReferences} unqualified references ·{' '}
                {money(row.costPerMergedDeliverableUsd)} / merged PR
                {row.costEstimated ? ' est.' : ''}
                {row.unpricedSessions ||
                row.unknownPRs ||
                row.unqualifiedPRReferences
                  ? ' partial'
                  : ''}
              </Text>
            </div>
          </article>
        ))}
      </div>
      {rows.length > shown.length && (
        <Text size="xs" c="dimmed">
          Showing {shown.length} of {rows.length}; summary includes all groups.
        </Text>
      )}
    </OpsPanel>
  );
}

export function SpendBreakdowns({
  spend,
  budget,
}: {
  spend: SessionSpend;
  budget: CostBudget;
}) {
  return (
    <Stack gap="md" data-testid="spend-breakdowns">
      <OpsPanel
        title="Known session spend"
        count={money(spend.totals.costUsd)}
        meta={spend.totals.costEstimated ? 'includes estimates' : undefined}
        className="costs-spend-summary"
        aria-label="Spend summary"
      >
        <Text size="sm" mt="xs">
          Reported {money(spend.totals.reportedCostUsd)} · estimated{' '}
          {money(spend.totals.estimatedCostUsd)} ·{' '}
          {spend.totals.unpricedSessions} unpriced sessions
          {spend.coverageLimited ? ' · incomplete archive' : ''}
        </Text>
        <Text size="sm" data-testid="cost-per-deliverable">
          {money(spend.costPerMergedDeliverableUsd)} per merged deliverable
          {spend.totals.costEstimated ? ' (includes estimates)' : ''} ·{' '}
          {spend.mergedPRs} merged PRs · {spend.unmergedPRs} unmerged ·{' '}
          {spend.unknownPRs} unknown · {spend.totals.unqualifiedPRReferences}{' '}
          unqualified references
        </Text>
        <Text size="sm" data-testid="cost-budget-state">
          {assessCostBudget(spend, budget)}
          {budget.state === 'configured'
            ? ` · ${money(budget.limitUsd)} limit · warning at ${budget.warningPercent}%`
            : ''}
        </Text>
        <Text size="xs" c="dimmed">
          Whole cumulative spend of sessions active in the selected window,
          including failed attempts and sessions without PRs. This is not billed
          spend incurred during that window. Reported costs come from provider
          transcripts; estimates use available model rates. Unknown or unpriced
          data makes totals partial. The denominator counts unique known-merged
          PRs with qualified creating-command evidence from these sessions,
          regardless of merge date. Legacy number-only references are excluded
          from the denominator. PR counts across groups overlap.
        </Text>
      </OpsPanel>
      {/* One column: seven-column tables need the full panel width. */}
      <div className="costs-ledger-grid costs-ledger-grid--stacked">
        <Breakdown
          title="By pipeline"
          label="Pipeline"
          rows={spend.byPipeline}
        />
        <Breakdown
          title="By requested model"
          label="Requested model"
          rows={spend.byRequestedModel}
        />
        <Breakdown
          title="By resolved model"
          label="Resolved model"
          rows={spend.byResolvedModel}
        />
      </div>
      <OpsPanel
        title="Deliverable attribution"
        count={spend.deliverables.length}
        meta="known cost split across publication references"
        className="costs-ledger-section costs-deliverables"
        aria-label="Deliverable attribution"
      >
        <Text size="xs" c="dimmed">
          Each session's known cost is split equally across its unique qualified
          publication references, including unmerged and unknown PRs. Without
          qualified publication references: {spend.withoutPR.sessions} sessions,{' '}
          {money(spend.withoutPR.costUsd)} known spend,{' '}
          {spend.withoutPR.unpricedSessions} unpriced.
        </Text>
        <div role="list" aria-label="Costs by deliverable">
          {spend.deliverables.slice(0, 15).map((row) => (
            <div
              key={row.key}
              role="listitem"
              className="costs-spend-deliverable"
            >
              <Anchor
                href={row.url}
                target="_blank"
                rel="noreferrer"
                className="costs-spend-identity"
              >
                GitHub {row.key}
              </Anchor>
              <Text size="sm">
                {row.status} · {row.sessions} sessions · reported{' '}
                {money(row.reportedCostUsd)} · estimated{' '}
                {money(row.estimatedCostUsd)} ·{' '}
                {row.unpricedShares.toLocaleString('en-US', {
                  maximumFractionDigits: 2,
                })}{' '}
                unpriced session shares
              </Text>
            </div>
          ))}
        </div>
        {spend.deliverables.length > 15 && (
          <Text size="xs" c="dimmed">
            Showing 15 of {spend.deliverables.length}; summary includes all
            deliverables.
          </Text>
        )}
      </OpsPanel>
    </Stack>
  );
}
