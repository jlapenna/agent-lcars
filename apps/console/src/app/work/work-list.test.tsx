import type { ItemView } from '@agent-lcars/work/derive';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkList } from './work-list';

const item: ItemView = {
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  state: 'parked',
  spec: {
    title: 'Add healthz',
    description: 'd',
    pipeline: 'claude',
    target: { repo: 'jlapenna/agent-lcars' },
  },
  origin: { principal: 'user:jlapenna', channel: 'api' },
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:05:00.000Z',
  runs: [],
  sessions: [],
};

function renderList(items: ItemView[]) {
  render(
    <MantineProvider>
      <WorkList items={items} />
    </MantineProvider>,
  );
}

describe('WorkList', () => {
  it('renders parked items first with their state and pipeline', () => {
    renderList([
      { ...item, id: '01J5Z3K9QX8F0N2B4V6C8D1E3H', state: 'running' },
      item,
    ]);
    const rows = screen.getAllByRole('link', { name: /Add healthz/ });
    expect(rows[0]).toHaveAttribute('href', `/work/${item.id}`);
    expect(screen.getAllByText('parked')[0]).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    renderList([]);
    expect(screen.getByText(/No work items yet/)).toBeInTheDocument();
  });
});
