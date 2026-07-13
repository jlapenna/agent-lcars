import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';

import type { ActionItem } from '../lib/action-items';
import { ActionItemCard } from './action-item-card';

// actions.ts is 'use server' and pulls in auth/firestore/GitHub client -
// out of scope here, matching the pattern in action-items-board.test.tsx.
jest.mock('./actions', () => ({
  mergePr: jest.fn(),
  replyToItem: jest.fn(),
}));
jest.mock('./cancel-run-button', () => ({
  CancelRunButton: () => null,
}));
jest.mock('./retrigger-button', () => ({
  RetriggerButton: () => null,
}));

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/members/issues/1',
    updatedAt: '2026-07-07T00:00:00Z',
    actionTypes: [],
    labels: [],
    ...overrides,
  };
}

function renderCard(item: ActionItem) {
  render(
    <MantineProvider>
      <ActionItemCard item={item} updatedAtLabel="now" />
    </MantineProvider>,
  );
}

describe('ActionItemCard', () => {
  it('keeps the header row wrapping instead of squeezing the title next to badges', () => {
    renderCard(
      makeItem({
        title: 'A title that should stay readable next to several badges',
        actionTypes: [
          'human-needed',
          'run-failed',
          'review-requested',
          'post-deploy-action',
        ],
      }),
    );

    const title = screen.getByRole('link', {
      name: /A title that should stay readable next to several badges/,
    });
    // The header Group must not force the title and badge row onto a
    // single non-wrapping line - that's what squeezes the title down to a
    // sliver when several action-type badges are present (#2745).
    const headerRow = title.closest('[class*="Group-root"]');
    expect(headerRow?.getAttribute('style')).not.toContain(
      '--group-wrap: nowrap',
    );

    for (const label of [
      'Needs a human',
      'CI run failed',
      'Review requested',
      'Awaiting next deploy',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
