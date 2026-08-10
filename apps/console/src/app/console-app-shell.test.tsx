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
    expect(screen.getAllByRole('heading', { name: 'Bridge' })).toHaveLength(2);
    expect(
      document.querySelector('.console-page-mobile-title'),
    ).toHaveTextContent('Bridge');
    expect(screen.getByRole('main')).toHaveTextContent('Route content');
  });

  it('marks its mobile title as a streamed fallback with the shared header', () => {
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
        '.console-page-mobile-title[data-current="sessions"][data-streaming-fallback]',
      ),
    ).toHaveTextContent('Session detail');
  });
});
