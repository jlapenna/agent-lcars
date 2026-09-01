import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import { QueueUtilityMenu } from './queue-utility-menu';

// 'use server' actions - out of scope here, matching item-overflow-menu.test.tsx.
vi.mock('./actions', () => ({
  approveAndRebase: vi.fn(),
  assignPipeline: vi.fn(),
  closeIssue: vi.fn(),
  mergePr: vi.fn(),
  clearHumanNeeded: vi.fn(),
  rebasePr: vi.fn(),
  updateIssueContent: vi.fn(),
}));

vi.mock('@mantine/modals', () => ({
  modals: { openConfirmModal: vi.fn() },
}));

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: DEFAULT_REPO,
    number: 4980,
    title: 'Stale tracker',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/4980',
    updatedAt: '2026-07-07T00:00:00Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

async function openMenu() {
  fireEvent.click(screen.getByRole('button'));
  await screen.findByRole('menu');
}

describe('QueueUtilityMenu', () => {
  // Regression test for agent-lcars#1676: the task detail page's mobile
  // header used to render this component's own dots trigger next to a
  // second one from ItemOverflowMenu.
  it('folds an item overflow menu into the same single trigger, not a second one', async () => {
    render(
      <MantineProvider>
        <QueueUtilityMenu
          repositoryUrl="https://github.com/supersprinklesracing/sprinkles"
          signOutControl={<button>Sign out</button>}
          item={makeItem()}
        />
      </MantineProvider>,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);

    await openMenu();

    expect(screen.getByText('#4980')).toBeTruthy();
    expect(screen.getByText('Edit issue')).toBeTruthy();
    expect(screen.getByText('Close issue')).toBeTruthy();
    expect(screen.getByText(/Switch to (dark|light) mode/)).toBeTruthy();
  });

  it('omits the item section entirely when no item is passed', async () => {
    render(
      <MantineProvider>
        <QueueUtilityMenu
          repositoryUrl="https://github.com/supersprinklesracing/sprinkles"
          signOutControl={<button>Sign out</button>}
        />
      </MantineProvider>,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);

    await openMenu();

    expect(screen.queryByText('Edit issue')).toBeNull();
    expect(screen.getByText(/Switch to (dark|light) mode/)).toBeTruthy();
  });

  it('omits the item section when the item offers no actions', async () => {
    render(
      <MantineProvider>
        <QueueUtilityMenu
          repositoryUrl="https://github.com/supersprinklesracing/sprinkles"
          signOutControl={<button>Sign out</button>}
          item={makeItem({ kind: 'pr' })}
        />
      </MantineProvider>,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);

    await openMenu();

    expect(screen.queryByText('#4980')).toBeNull();
    expect(screen.getByText(/Switch to (dark|light) mode/)).toBeTruthy();
  });
});
