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

// Below `sm`, WorkList renders a card list instead of the 6-column table
// (#1814); both branches render unconditionally in jsdom (which doesn't
// evaluate the visibleFrom/hiddenFrom CSS media queries that keep only one
// visible in a real browser - see session-table.test.tsx for the same
// pattern elsewhere in this repo), so any row content shared by both views
// appears twice and needs getAllBy* rather than getBy*.
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

  it('links a title to its item detail page in both the card and table views', () => {
    renderList([item]);
    const links = screen.getAllByRole('link', { name: 'Add healthz' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', `/work/${item.id}`);
    }
  });

  it('shows an empty state', () => {
    renderList([]);
    expect(screen.getByText(/No work items yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('work-cards')).toBeNull();
  });
});
