import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConsoleFooter } from './console-footer';

// auth.ts constructs NextAuth at module load and pulls in next-auth's
// server-only entrypoints - the same reason actions.test.ts stubs it. The
// button under test only needs `signOut` to exist as a callable; the form
// is never submitted here (jsdom has no server-action runtime).
vi.mock('../auth', () => ({ signOut: vi.fn(), auth: vi.fn() }));

function renderFooter() {
  return render(
    <MantineProvider>
      <ConsoleFooter />
    </MantineProvider>,
  );
}

describe('ConsoleFooter', () => {
  it('offers a way out of a signed-in session (#27)', () => {
    renderFooter();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('keeps the theme toggle alongside it', () => {
    renderFooter();
    expect(
      screen.getByRole('button', { name: /Switch to (?:dark|light) mode/ }),
    ).toBeTruthy();
  });
});
