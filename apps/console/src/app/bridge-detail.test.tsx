import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import { BridgeDetail } from './bridge-detail';
import type { BridgeDetail as Descriptor } from './bridge-rows';

// The real detail renderers pull the 'use server' actions module (auth,
// firestore, GitHub client) via ActionItemCard, which jsdom can't load -
// mirror action-items-board.test.tsx and stub them; this suite is about the
// pane's selection chrome, not the children's internals.
vi.mock('./action-item-card', () => ({
  ActionItemCard: ({ item }: { item: { number: number } }) => (
    <div data-testid="full-card">#{item.number}</div>
  ),
}));
vi.mock('./agent-activity-panel', () => ({
  LiveRunRow: () => <div data-testid="live-run-detail" />,
  FinishedRunRow: () => <div data-testid="recent-run-detail" />,
  CliSessionRow: () => <div data-testid="session-detail" />,
}));
vi.mock('./parked-work-detail', () => ({
  ParkedWorkDetail: ({ item }: { item: { id: string } }) => (
    <div data-testid="parked-work-detail">{item.id}</div>
  ),
}));

function renderItem(number: number): Descriptor {
  return {
    kind: 'item',
    multiRepo: false,
    card: { item: { number } as ActionItem },
  };
}

describe('BridgeDetail', () => {
  it('shows a guidance empty state when no row is selected', () => {
    render(
      <MantineProvider>
        <BridgeDetail detail={{ kind: 'none' }} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('bridge-detail-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('bridge-detail')).toBeNull();
  });

  it('renders the workspace card for a deploy-wait item', () => {
    render(
      <MantineProvider>
        <BridgeDetail detail={renderItem(30)} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('full-card')).toBeInTheDocument();
    expect(screen.getByTestId('bridge-detail')).toBeInTheDocument();
  });

  it('offers a back control that clears the selection for every kind', () => {
    render(
      <MantineProvider>
        <BridgeDetail detail={renderItem(30)} repoFilterKey="o/r" />
      </MantineProvider>,
    );
    expect(screen.getByText('← All activity')).toHaveAttribute(
      'href',
      '/?repo=o%2Fr',
    );
  });

  it('renders the run detail variant for a live run', () => {
    const detail: Descriptor = { kind: 'liveRun', run: { id: 'r1' } };
    render(
      <MantineProvider>
        <BridgeDetail detail={detail} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('live-run-detail')).toBeInTheDocument();
  });

  it('renders the parked-work detail variant for a stopped item', () => {
    const detail: Descriptor = {
      kind: 'parkedWork',
      item: { id: 'work:ulid1' } as never,
    };
    render(
      <MantineProvider>
        <BridgeDetail detail={detail} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('parked-work-detail')).toHaveTextContent(
      'work:ulid1',
    );
    expect(screen.getByText('Stopped work')).toBeInTheDocument();
  });
});
