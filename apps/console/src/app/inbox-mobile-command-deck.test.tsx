import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InboxMobileCommandDeck } from './inbox-mobile-command-deck';

vi.mock('./quick-task-button', () => ({
  QuickTaskButton: () => <button>Quick task</button>,
}));
vi.mock('./refresh-button', () => ({
  RefreshButton: () => <button>Refresh</button>,
}));

function renderDeck(
  overrides: Partial<Parameters<typeof InboxMobileCommandDeck>[0]> = {},
) {
  return render(
    <MantineProvider>
      <InboxMobileCommandDeck
        view="list"
        openItemCount={7}
        backHref="/inbox"
        watchedRepos={[{ owner: 'supersprinklesracing', name: 'sprinkles' }]}
        utilityMenu={<button>More console options</button>}
        scopeLabel="Sprinkles"
        dataFreshness={<span>Data as of just now</span>}
        {...overrides}
      />
    </MantineProvider>,
  );
}

describe('InboxMobileCommandDeck', () => {
  it('puts the list identity, primary utilities, scope, and freshness in one command deck', () => {
    renderDeck();

    expect(screen.getByTestId('inbox-mobile-command-deck')).toBeTruthy();
    expect(screen.getByLabelText('7 open queue items')).toBeTruthy();
    expect(screen.getByText('Inbox', { exact: true })).toBeTruthy();
    expect(screen.getByText('Quick task')).toBeTruthy();
    expect(screen.getByText('Refresh')).toBeTruthy();
    expect(screen.getByText('Sprinkles')).toBeTruthy();
    expect(screen.getByText('Data as of just now')).toBeTruthy();
  });

  it('uses the command deck as the sole selected-item identity on detail', () => {
    renderDeck({
      view: 'detail',
      selectedItem: {
        repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
        number: 9003,
      },
    });

    expect(screen.queryByText('Inbox', { exact: true })).toBeNull();
    expect(screen.getByText('sprinkles / #9003', { exact: true })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Back to Inbox list' }),
    ).toHaveAttribute('href', '/inbox');
    expect(screen.getByText('Data as of just now')).toBeTruthy();
  });
});
