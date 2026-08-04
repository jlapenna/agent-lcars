import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { BoardCard } from './board-card';
import { YourQueueSection } from './your-queue-section';

// actions.ts is 'use server' and pulls in auth/firestore/GitHub client -
// out of scope here, matching action-item-card.test.tsx's own mock.
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('./actions', () => ({
  mergePr: vi.fn(),
  replyToItem: vi.fn(),
  dispatchUnstickPrs: vi.fn(),
  closeIssue: vi.fn(),
  clearHumanNeeded: vi.fn(),
}));

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: DEFAULT_REPO,
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/1',
    updatedAt: '2026-07-07T00:00:00Z',
    actionTypes: ['needs-human'],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

function card(item: ActionItem): BoardCard {
  return { item, updatedAtLabel: 'now' };
}

function renderSection(cards: BoardCard[], multiRepo = false) {
  render(
    <MantineProvider>
      <YourQueueSection cards={cards} multiRepo={multiRepo} />
    </MantineProvider>,
  );
}

// Mantine's Menu.Dropdown mounts asynchronously (Floating UI positioning),
// matching item-overflow-menu.test.tsx's own openMenu() helper.
async function muteItem(number: number) {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`more actions for #${number}`, 'i'),
    }),
  );
  fireEvent.click(await screen.findByText('Mute'));
}

describe('YourQueueSection (#59)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows every card and the true count when nothing is muted', () => {
    renderSection([
      card(makeItem({ number: 1, title: 'First' })),
      card(makeItem({ number: 2, title: 'Second' })),
    ]);

    expect(screen.getByText('#1 First')).toBeTruthy();
    expect(screen.getByText('#2 Second')).toBeTruthy();
    expect(
      screen.getByText('2 items · Needs your decision or response.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('muted-queue-items')).toBeNull();
  });

  it('moves a muted item out of the list, into a collapsed Muted section, and updates the count', async () => {
    renderSection([
      card(makeItem({ number: 1, title: 'First' })),
      card(makeItem({ number: 2, title: 'Second' })),
    ]);

    await muteItem(1);

    // #1 now renders only once - as the muted section's compact row, not
    // as a full "Your Queue" card (both render "#<n> <title>" text, so a
    // bare queryByText would find the surviving muted-row copy).
    expect(screen.getAllByText('#1 First')).toHaveLength(1);
    expect(screen.getByText('#2 Second')).toBeTruthy();
    expect(
      screen.getByText('1 item · Needs your decision or response.'),
    ).toBeTruthy();

    const muted = screen.getByTestId('muted-queue-items');
    expect(within(muted).getByText('#1 First')).toBeTruthy();
  });

  it('restores a muted item to the list on Unmute', async () => {
    renderSection([card(makeItem({ number: 1, title: 'First' }))]);

    await muteItem(1);
    fireEvent.click(
      within(screen.getByTestId('muted-queue-items')).getByRole('button', {
        name: 'Unmute',
      }),
    );

    expect(screen.getByText('#1 First')).toBeTruthy();
    expect(screen.queryByTestId('muted-queue-items')).toBeNull();
  });

  it('persists the mute across a remount via localStorage', async () => {
    const cards = [card(makeItem({ number: 1, title: 'First' }))];
    const { unmount } = render(
      <MantineProvider>
        <YourQueueSection cards={cards} multiRepo={false} />
      </MantineProvider>,
    );

    await muteItem(1);
    unmount();

    renderSection(cards);

    expect(screen.getAllByText('#1 First')).toHaveLength(1);
    expect(screen.getByTestId('muted-queue-items')).toBeTruthy();
  });

  it('shows the empty-queue message once every item is muted', async () => {
    renderSection([card(makeItem({ number: 1, title: 'First' }))]);

    await muteItem(1);

    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
  });

  it('shows the configured alias on a muted item row in multi-repo mode', async () => {
    renderSection(
      [
        card(
          makeItem({
            number: 1,
            title: 'First',
            repo: { owner: 'org-a', name: 'repo-a', alias: 'Repo A' },
          }),
        ),
      ],
      true,
    );

    await muteItem(1);

    const muted = screen.getByTestId('muted-queue-items');
    expect(within(muted).getByTestId('repo-badge').textContent).toBe('Repo A');
  });

  it('folds author and labels into a muted row second line (#169)', async () => {
    renderSection([
      card(
        makeItem({
          number: 1,
          title: 'First',
          author: 'octocat',
          labels: ['agent:claude'],
        }),
      ),
    ]);

    await muteItem(1);

    const muted = screen.getByTestId('muted-queue-items');
    expect(
      within(muted).getByText(/updated now · by octocat · agent:claude/),
    ).toBeTruthy();
  });
});
