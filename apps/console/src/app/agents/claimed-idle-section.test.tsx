import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../../lib/action-items';
import { ClaimedIdleSection } from './claimed-idle-section';

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: { owner: 'supersprinklesracing', name: 'members' },
    number: 1,
    title: 'Stale claim',
    url: 'https://github.com/supersprinklesracing/members/issues/1',
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    actionTypes: [],
    labels: [],
    assigneeLogins: ['jclaw-bot'],
    ...overrides,
  };
}

function renderSection(items: ActionItem[]) {
  render(
    <MantineProvider>
      <ClaimedIdleSection items={items} />
    </MantineProvider>,
  );
}

describe('ClaimedIdleSection', () => {
  it('shows the empty state when nothing is stale', () => {
    renderSection([]);
    expect(
      screen.getByText(
        'Every jclaw-bot claim has a live run or session behind it.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Claimed but Idle (0)')).toBeTruthy();
  });

  it('renders one row per stale claim with its updated-at age', () => {
    renderSection([makeItem({ number: 5, title: 'Fix the thing' })]);
    expect(screen.getByText('Claimed but Idle (1)')).toBeTruthy();
    expect(screen.getByTestId('compact-item-5')).toHaveTextContent(
      '#5 Fix the thing',
    );
    expect(screen.getByTestId('compact-item-5')).toHaveTextContent(
      /updated .+ ago/,
    );
  });

  it('shows the takeover command when the item has one', () => {
    renderSection([
      makeItem({
        number: 5,
        takeoverCommand: '~/p/members/tools/claude-agent-session.sh resume x',
      }),
    ]);
    expect(
      screen.getByText('~/p/members/tools/claude-agent-session.sh resume x'),
    ).toBeTruthy();
  });

  it('renders no takeover chip when the item has none', () => {
    renderSection([makeItem({ number: 5 })]);
    expect(screen.queryByText('Takeover:')).toBeNull();
  });
});
