import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NavPageLoading } from './page-loading';

// #585: the outer Suspense boundary that gates a nav-destination page on
// `auth()` used to fall back to a generic skeleton with a different
// shape/height than the real `ConsoleHeader`, so every page load reflowed
// and ghosted the header the instant `auth()` resolved. `NavPageLoading`
// renders the real header instead, so the swap never changes shape.
describe('NavPageLoading', () => {
  it('renders the real header title and nav rail, not a skeleton', () => {
    render(
      <MantineProvider>
        <NavPageLoading
          current="agents"
          title="Agent Status"
          className="agents-page-shell"
        />
      </MantineProvider>,
    );

    expect(
      screen.getAllByRole('heading', { name: 'Agent Status' }),
    ).toHaveLength(2);
    expect(
      screen.getByRole('link', { name: 'Agents' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('link', { name: 'Agents' })
        .closest('.console-header')
        ?.hasAttribute('data-streaming-fallback'),
    ).toBe(true);
  });

  it('keeps Inbox labelled and navigable while its command deck is unavailable', () => {
    render(
      <MantineProvider>
        <NavPageLoading
          current="inbox"
          title="Decision Inbox"
          className="inbox-page-shell"
        />
      </MantineProvider>,
    );

    expect(
      screen.getByRole('link', { name: 'Inbox' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });
});
