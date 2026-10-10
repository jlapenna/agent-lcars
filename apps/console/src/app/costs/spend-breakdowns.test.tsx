import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
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
});
