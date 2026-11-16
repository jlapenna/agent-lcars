import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  aggregateSessionSpend,
  parseCostBudget,
} from '../../lib/session-spend';
import { SpendBreakdowns } from './spend-breakdowns';

describe('spend disclosure', () => {
  it('keeps no-merge metrics and unavailable archive honest', () => {
    render(
      <MantineProvider>
        <SpendBreakdowns
          spend={aggregateSessionSpend([], new Map(), true)}
          budget={parseCostBudget('100')}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('cost-per-deliverable')).toHaveTextContent(
      '— per merged deliverable',
    );
    expect(screen.getByTestId('cost-budget-state')).toHaveTextContent(
      'Cannot assess: incomplete spend',
    );
    expect(screen.getByText(/Whole cumulative spend/)).toHaveTextContent(
      'not billed spend incurred during that window',
    );
    for (const title of [
      'By pipeline',
      'By requested model',
      'By resolved model',
    ])
      expect(screen.getByRole('region', { name: title })).toBeTruthy();
  });

  it('shows the top 15 groups and deliverables and discloses every other one', () => {
    const empty = aggregateSessionSpend([], new Map(), false);
    const groups = Array.from({ length: 18 }, (_, i) => ({
      ...empty.totals,
      key: `pipeline-${i + 1}`,
      sessions: 1,
      mergedPRs: 0,
      unknownPRs: 0,
    }));
    const deliverables = Array.from({ length: 21 }, (_, i) => ({
      key: `octo/example#${i + 1}`,
      url: `https://github.com/octo/example/pull/${i + 1}`,
      status: 'merged' as const,
      reportedCostUsd: 1,
      estimatedCostUsd: 0,
      unpricedShares: 0,
      sessions: 1,
    }));
    render(
      <MantineProvider>
        <SpendBreakdowns
          spend={{ ...empty, byPipeline: groups, deliverables }}
          budget={parseCostBudget('100')}
        />
      </MantineProvider>,
    );
    const pipeline = screen.getByRole('region', { name: 'By pipeline' });
    const groupRemainder = within(pipeline).getByTestId(
      'spend-breakdown-remainder',
    );
    expect(groupRemainder).toHaveTextContent(
      'Showing 15 of 18 · show 3 more groups',
    );
    expect(within(groupRemainder).getAllByText('pipeline-18')).toHaveLength(2);
    expect(within(pipeline).getAllByText('pipeline-1')).toHaveLength(2);

    const remainder = screen.getByTestId('deliverable-remainder');
    expect(remainder).toHaveTextContent(
      'Showing 15 of 21 · show 6 more deliverables',
    );
    expect(
      within(remainder).getByRole('link', { name: 'GitHub octo/example#21' }),
    ).toHaveAttribute('href', 'https://github.com/octo/example/pull/21');
    expect(
      screen.getAllByRole('link', { name: /^GitHub octo\/example#/ }),
    ).toHaveLength(21);
  });
});
