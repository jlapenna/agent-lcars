import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SpendByRepository } from './spend-by-repository';

function renderSpend(props: Parameters<typeof SpendByRepository>[0]) {
  render(
    <MantineProvider>
      <SpendByRepository {...props} />
    </MantineProvider>,
  );
}

describe('SpendByRepository', () => {
  it('shows today, the seven-day meter and spend per session', () => {
    renderSpend({
      spend: {
        todayUsd: 3,
        sevenDayUsd: 9,
        sevenDayUnavailable: false,
        rows: [
          {
            repo: 'jlapenna/agent-lcars',
            todayUsd: 3,
            sevenDayUsd: 8,
            sessions7d: 4,
            perSessionUsd: 2,
            estimated: true,
            unpriced: 1,
          },
        ],
      },
    });
    const panel = screen.getByTestId('spend-by-repository');
    expect(within(panel).getByText('$3.00 today')).toBeInTheDocument();
    expect(within(panel).getByText(/7-day total \$9\.00/)).toBeInTheDocument();
    const row = screen.getByTestId('repo-spend-jlapenna/agent-lcars');
    expect(row).toHaveTextContent('$8.00 est.');
    expect(row).toHaveTextContent('(1 unpriced)');
    expect(row).toHaveTextContent('$2.00 est.');
    expect(
      within(row).getByRole('img', { name: '100% of the largest repository' }),
    ).toBeInTheDocument();
  });

  it('withholds seven-day figures for a window shorter than seven days', () => {
    renderSpend({
      spend: {
        todayUsd: 1,
        sevenDayUsd: 1,
        sevenDayUnavailable: true,
        rows: [
          {
            repo: 'jlapenna/homelab',
            todayUsd: 1,
            sevenDayUsd: 1,
            sessions7d: 1,
            perSessionUsd: 1,
            estimated: false,
            unpriced: 0,
          },
        ],
      },
    });
    expect(
      screen.getByText(/7-day total unavailable · window under 7 days/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
