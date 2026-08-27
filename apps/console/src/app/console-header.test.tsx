import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionArchiveQuery } from '@/lib/session-archive';

import {
  ConsoleHeader,
  ConsoleNavRail,
  DataWarnings,
  type NavKey,
} from './console-header';

function renderHeader(current: NavKey, archiveQuery?: SessionArchiveQuery) {
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

describe('DataWarnings', () => {
  it('uses the shared disclosure control for every route that renders it', () => {
    const { container } = render(
      <MantineProvider>
        <DataWarnings warnings={['GitHub data is stale.']} />
      </MantineProvider>,
    );

    const disclosure = screen.getByTestId('data-warnings');
    expect(disclosure).toHaveClass('lcars-disclosure', 'lcars-data-warnings');
    expect(disclosure.querySelector('summary')).toHaveClass(
      'lcars-disclosure__summary',
    );
    expect(container.querySelector('.lcars-disclosure__content')).toBeTruthy();
  });
});

describe('ConsoleHeader nav rail', () => {
  it('places route utilities beside the global navigation', () => {
    const view = render(
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
    expect(view.container.querySelector('.console-header')).toHaveAttribute(
      'data-has-utilities',
    );
  });

  it('marks utility-less shells so mobile can retain a route-home fallback', () => {
    const view = renderHeader('deck');

    expect(view.container.querySelector('.console-header')).not.toHaveAttribute(
      'data-has-utilities',
    );
    expect(screen.getByRole('link', { name: 'Bridge' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('offers every console destination', () => {
    renderHeader('deck');

    expect(
      screen.getByRole('navigation', { name: 'Console sections' }),
    ).toBeTruthy();
    for (const [name, href] of [
      ['Bridge', '/'],
      ['Inbox', '/inbox'],
      ['Agents', '/agents'],
      ['Shuttlebay', '/shuttlebay'],
      ['Work', '/work'],
      ['Sessions', '/sessions'],
      ['Costs', '/costs'],
    ]) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(
        href,
      );
    }
  });

  it('marks Work as current on the work pages', () => {
    renderHeader('work');
    expect(
      screen.getByRole('link', { name: 'Work' }).getAttribute('aria-current'),
    ).toBe('page');
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
      screen.getByRole('link', { name: 'Bridge' }).getAttribute('href'),
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

    expect(screen.getByRole('link', { name: 'Bridge' })).toHaveAttribute(
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
  it('renders every destination with the parent marked current', () => {
    render(
      <MantineProvider>
        <ConsoleNavRail current="sessions" />
      </MantineProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Console sections' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(7);
    expect(within(nav).getByRole('link', { name: 'Sessions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: 'Bridge' }),
    ).not.toHaveAttribute('aria-current');
  });
});
