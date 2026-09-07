import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConsoleAppShell } from './console-app-shell';

describe('ConsoleAppShell', () => {
  it('keeps the shared header and page content in one structural frame', () => {
    render(
      <MantineProvider>
        <ConsoleAppShell
          current="deck"
          title="Bridge"
          subtitle="Console overview"
        >
          <p>Route content</p>
        </ConsoleAppShell>
      </MantineProvider>,
    );

    expect(
      screen.getByRole('navigation', { name: 'Console sections' }),
    ).toBeTruthy();
    // One shared title remains visible and semantic at every viewport.
    expect(screen.getAllByRole('heading', { name: 'Bridge' })).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveTextContent('Route content');
  });

  it('wraps a route footer so it can pin to the viewport bottom on a short page', () => {
    const { container } = render(
      <MantineProvider>
        <ConsoleAppShell
          current="sessions"
          title="Session detail"
          subtitle="A streamed archive record"
          footer={<p>Footer actions</p>}
        >
          <p>Route content</p>
        </ConsoleAppShell>
      </MantineProvider>,
    );

    const footer = container.querySelector('.console-page-footer');
    expect(footer).toHaveTextContent('Footer actions');
  });

  it('omits the footer wrapper when a route has no footer', () => {
    const { container } = render(
      <MantineProvider>
        <ConsoleAppShell
          current="deck"
          title="Bridge"
          subtitle="Console overview"
        >
          <p>Route content</p>
        </ConsoleAppShell>
      </MantineProvider>,
    );

    expect(container.querySelector('.console-page-footer')).toBeNull();
  });

  it('marks the shared header as a streamed fallback', () => {
    const { container } = render(
      <MantineProvider>
        <ConsoleAppShell
          current="sessions"
          title="Session detail"
          subtitle="A streamed archive record"
          streamingFallback
        >
          <p>Loading route content</p>
        </ConsoleAppShell>
      </MantineProvider>,
    );

    expect(
      container.querySelector(
        '.console-header[data-current="sessions"][data-streaming-fallback]',
      ),
    ).toHaveTextContent('Session detail');
  });
});
