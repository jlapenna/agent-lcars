import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionArchiveQuery } from '@/lib/session-archive';

import { ConsoleHeader, ConsoleNavRail } from './console-header';

function renderHeader(
  current: 'deck' | 'inbox' | 'agents' | 'sessions' | 'costs',
  archiveQuery?: SessionArchiveQuery,
) {
  return render(
    <MantineProvider>
      <ConsoleHeader
        current={current}
        title="Cost Ledger"
        subtitle="last 14 days"
        archiveQuery={archiveQuery}
      />
    </MantineProvider>,
  );
}

describe('ConsoleHeader subtitle', () => {
  // #243: a subtitle free to wrap makes the header a different height on
  // whichever tab's content happens to be longest that day. Truncating to
  // one line keeps every tab's header the same height regardless of copy.
  it('is truncated to a single line', () => {
    renderHeader('costs');

    expect(screen.getByText('last 14 days').getAttribute('data-truncate')).toBe(
      'end',
    );
  });
});

describe('ConsoleHeader nav rail', () => {
  it('places route utilities beside the global navigation', () => {
    render(
      <MantineProvider>
        <ConsoleHeader
          current="deck"
          title="Agent LCARS"
          subtitle="Bridge"
          utilities={<button>Quick task</button>}
        />
      </MantineProvider>,
    );

    const navigation = screen.getByRole('navigation', {
      name: 'Console sections',
    });
    const commandRow = navigation.parentElement;
    expect(commandRow?.querySelector('button')?.textContent).toBe('Quick task');
  });

  it('offers every console destination', () => {
    renderHeader('deck');

    expect(
      screen.getByRole('navigation', { name: 'Console sections' }),
    ).toBeTruthy();
    for (const [name, href] of [
      ['Deck', '/'],
      ['Inbox', '/inbox'],
      ['Agents', '/agents'],
      ['Sessions', '/sessions'],
      ['Costs', '/costs'],
    ]) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(
        href,
      );
    }
  });

  // Costs is a destination of its own since #192 ("a whole separate page,
  // not embedded in sessions, even as a tab"), so it has to mark itself
  // current the same way the other three do rather than leaving Sessions
  // lit while the cost ledger is on screen.
  it('marks the page it is on as current, including Costs', () => {
    renderHeader('costs');

    expect(
      screen.getByRole('link', { name: 'Costs' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('link', { name: 'Sessions' })
        .getAttribute('aria-current'),
    ).toBeNull();
  });

  it('preserves archive filters between Sessions and Costs', () => {
    renderHeader('sessions', {
      days: 90,
      source: 'cli',
      issueNumber: 42,
    });

    expect(
      screen.getByRole('link', { name: 'Sessions' }).getAttribute('href'),
    ).toBe('/sessions?days=90&source=cli&issue=42');
    expect(
      screen.getByRole('link', { name: 'Costs' }).getAttribute('href'),
    ).toBe('/costs?days=90&source=cli&issue=42');
    expect(
      screen.getByRole('link', { name: 'Deck' }).getAttribute('href'),
    ).toBe('/');
  });

  it('preserves repository scope between Deck and Inbox', () => {
    render(
      <MantineProvider>
        <ConsoleHeader
          current="deck"
          title="Bridge"
          subtitle="one repo"
          repoFilter="example/console"
        />
      </MantineProvider>,
    );

    expect(screen.getByRole('link', { name: 'Deck' })).toHaveAttribute(
      'href',
      '/?repo=example%2Fconsole',
    );
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'href',
      '/inbox?repo=example%2Fconsole',
    );
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'href',
      '/agents',
    );
  });
});

describe('ConsoleNavRail (standalone)', () => {
  it('renders all five destinations with the parent marked current', () => {
    render(
      <MantineProvider>
        <ConsoleNavRail current="sessions" />
      </MantineProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Console sections' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(within(nav).getByRole('link', { name: 'Sessions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Deck' })).not.toHaveAttribute(
      'aria-current',
    );
  });
});
