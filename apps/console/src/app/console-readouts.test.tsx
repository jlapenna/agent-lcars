import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConsoleReadouts } from './console-readouts';

describe('ConsoleReadouts', () => {
  it('labels the row and renders each figure with its context', () => {
    render(
      <MantineProvider>
        <ConsoleReadouts
          label="Bridge readouts"
          readouts={[
            { id: 'decisions', label: 'Decisions', value: 3, detail: 'open' },
            { id: 'agents', label: 'Agents running', value: 0 },
          ]}
        />
      </MantineProvider>,
    );

    const row = screen.getByRole('region', { name: 'Bridge readouts' });
    const decisions = within(row).getByTestId('readout-decisions');
    expect(decisions).toHaveTextContent('Decisions');
    expect(decisions).toHaveTextContent('3');
    expect(decisions).toHaveTextContent('open');
    expect(
      within(row)
        .getByTestId('readout-agents')
        .querySelector('.lcars-readout__detail'),
    ).toBeNull();
  });

  it('draws a sparkline, or the unavailable mark when there is no history', () => {
    render(
      <MantineProvider>
        <ConsoleReadouts
          label="Bridge readouts"
          readouts={[
            {
              id: 'queue',
              label: 'Queue depth',
              value: 3,
              spark: { label: 'Queue depth, last 30 minutes', values: [1, 3] },
            },
            {
              id: 'online',
              label: 'Runners online',
              value: 11,
              spark: { label: 'Runners online, last 30 minutes' },
            },
          ]}
        />
      </MantineProvider>,
    );
    expect(
      screen.getByRole('img', { name: 'Queue depth, last 30 minutes' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('img', {
        name: 'Runners online, last 30 minutes: unavailable',
      }),
    ).toHaveTextContent('—');
  });
});
