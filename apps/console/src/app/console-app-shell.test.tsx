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
    expect(screen.getByRole('heading', { name: 'Bridge' })).toBeTruthy();
    expect(screen.getByRole('main')).toHaveTextContent('Route content');
  });
});
