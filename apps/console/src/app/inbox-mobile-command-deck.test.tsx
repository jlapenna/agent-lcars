import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InboxMobileCommandDeck } from './inbox-mobile-command-deck';

function renderDeck(
  overrides: Partial<Parameters<typeof InboxMobileCommandDeck>[0]> = {},
) {
  return render(
    <MantineProvider>
      <InboxMobileCommandDeck
        view="list"
        backHref="/inbox"
        scopeLabel="Sprinkles"
        dataFreshness={<span>Data as of just now</span>}
        {...overrides}
      />
    </MantineProvider>,
  );
}

describe('InboxMobileCommandDeck', () => {
  it('leaves list identity and utilities to the shared header', () => {
    renderDeck();

    expect(screen.queryByTestId('inbox-mobile-command-deck')).toBeNull();
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
