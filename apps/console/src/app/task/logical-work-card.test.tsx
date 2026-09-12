import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { ActionItem } from '../../lib/action-items';
import type { LogicalWork } from '../../lib/logical-work';
import { closeIssue } from '../actions';
import { LogicalWorkCard } from './logical-work-card';

vi.mock('../actions', () => ({
  approveAndRebase: vi.fn(),
  assignPipeline: vi.fn(),
  clearHumanNeeded: vi.fn(),
  closeIssue: vi.fn(),
  mergePr: vi.fn(),
  rebasePr: vi.fn(),
  updateIssueContent: vi.fn(),
}));

// No ModalsProvider is mounted in these tests (only MantineProvider, matching
// the item-overflow-menu suite), so openConfirmModal is stubbed to invoke its
// onConfirm immediately - equivalent to the maintainer confirming.
vi.mock('@mantine/modals', () => ({
  modals: {
    openConfirmModal: vi.fn(({ onConfirm }) => onConfirm()),
  },
}));

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

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

const item: ActionItem = {
  kind: 'issue',
  repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
  number: 42,
  title: 'Fix the thing',
  url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
  updatedAt: '2026-08-29T00:00:00Z',
  actionTypes: [],
  labels: [],
  assigneeLogins: [],
};

function renderCard(runs: OrchestratorRun[] = [], withItem = false) {
  render(
    <MantineProvider>
      <LogicalWorkCard
        work={work}
        runs={runs}
        anchorState="open"
        item={withItem ? item : undefined}
      />
    </MantineProvider>,
  );
}

describe('LogicalWorkCard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

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

  it("offers the item's actions on the task body itself", async () => {
    (closeIssue as Mock).mockResolvedValue({ ok: true });
    renderCard([], true);
    fireEvent.click(
      screen.getByRole('button', { name: 'More actions for #42' }),
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Close issue' }),
    );
    await waitFor(() => expect(closeIssue).toHaveBeenCalledTimes(1));
  });

  it('renders no action control when the host has no item', () => {
    renderCard();
    expect(
      screen.queryByRole('button', { name: 'More actions for #42' }),
    ).not.toBeInTheDocument();
  });
});
