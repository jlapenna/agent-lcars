import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentOperationsPanel } from './agent-operations-panel';

describe('AgentOperationsPanel', () => {
  it('uses one consistent second-level heading and panel frame', () => {
    render(
      <MantineProvider>
        <AgentOperationsPanel
          title="Active Agents"
          className="agents-panel--active"
          testId="agent-panel"
          separated
        >
          <p>In flight work</p>
        </AgentOperationsPanel>
      </MantineProvider>,
    );

    expect(
      screen.getByRole('heading', { level: 2, name: 'Active Agents' }),
    ).toBeTruthy();
    expect(screen.getByTestId('agent-panel')).toHaveTextContent(
      'In flight work',
    );
  });
});
