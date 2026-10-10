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
import { Eyebrow } from '../eyebrow';
import { formatCost } from '../format';

const money = (value: number | undefined) =>
  value === undefined ? '—' : formatCost(value);

function Breakdown({
  title,
  id,
  rows,
}: {
  title: string;
  id: string;
  rows: SpendBreakdown[];
}) {
  const shown = rows.slice(0, 15);
  return (
    <section className="costs-ledger-section" aria-labelledby={id}>
      <div className="costs-ledger-section__heading" id={id}>
        <Eyebrow>{title}</Eyebrow>
      </div>
      <TableScrollContainer
        minWidth={600}
        visibleFrom="sm"
        className="costs-ledger-scroll"
      >
        <Table verticalSpacing="xs" fz="sm" className="costs-ledger-table">
          <TableThead>
            <TableTr>
              <TableTh>{title}</TableTh>
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
                  {row.mergedPRs} ({row.unknownPRs} unknown;{' '}
                  {row.unqualifiedPRReferences} unqualified references)
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
    </section>
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
      <section aria-label="Spend summary">
        <Text fw={600}>
          Known session spend: {money(spend.totals.costUsd)}
          {spend.totals.costEstimated ? ' (includes estimates)' : ''}
        </Text>
        <Text size="sm">
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
      </section>
      <div className="costs-ledger-grid">
        <Breakdown
          title="By pipeline"
          id="by-pipeline"
          rows={spend.byPipeline}
        />
        <Breakdown
          title="By requested model"
          id="by-requested-model"
          rows={spend.byRequestedModel}
        />
        <Breakdown
          title="By resolved model"
          id="by-resolved-model"
          rows={spend.byResolvedModel}
        />
      </div>
      <section aria-label="Deliverable attribution">
        <div className="costs-ledger-section__heading">
          <Eyebrow>Deliverable attribution</Eyebrow>
        </div>
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
                {row.key}
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
      </section>
    </Stack>
  );
}
