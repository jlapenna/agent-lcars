import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LogicalWork } from '../../lib/logical-work';
import { LogicalWorkCard } from './logical-work-card';

const work: LogicalWork = {
  task: {
    repository: { owner: 'supersprinklesracing', name: 'sprinkles' },
    issueNumber: 42,
  },
  title: 'Fix the thing',
  url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
  state: 'active',
  runs: [],
  anomalies: [],
  provenance: { kind: 'authoritative', revision: 3 },
};

const run: OrchestratorRun = {
  runId: 'supersprinklesracing/sprinkles#42/r1',
  task: { repo: 'supersprinklesracing/sprinkles', issue: 42 },
  state: 'running',
  pipeline: 'claude',
  requestId: 'request-1',
  leaseExpiresAt: '2026-08-29T01:00:00Z',
  events: [{ at: '2026-08-29T00:00:00Z', to: 'pending', by: 'request' }],
  createdAt: '2026-08-29T00:00:00Z',
  updatedAt: '2026-08-29T00:01:00Z',
};

function renderCard(runs: OrchestratorRun[] = []) {
  render(
    <MantineProvider>
      <LogicalWorkCard work={work} runs={runs} anchorState="open" />
    </MantineProvider>,
  );
}

describe('LogicalWorkCard', () => {
  it('renders GitHub task metadata and authoritative state', () => {
    renderCard();
    expect(
      screen.getByRole('link', { name: '#42 Fix the thing' }),
    ).toHaveAttribute('href', work.url);
    expect(screen.getByText('authoritative state rev 3')).toBeInTheDocument();
  });

  it('renders native run history without an Actions-attempt fallback', () => {
    renderCard([run]);
    expect(screen.getByTestId('runs-section')).toBeInTheDocument();
    expect(
      screen.queryByTestId('logical-work-attempts'),
    ).not.toBeInTheDocument();
  });
});
