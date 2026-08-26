import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkActions } from './work-actions';

// 'use client' component needs an app router context - mocked the same way
// refresh-button.test.tsx does, since no <AppRouterContext.Provider> is
// mounted in this render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe('WorkActions', () => {
  it('offers redispatch only when parked and cancel unless settled', () => {
    const noop = vi.fn(async () => [null, undefined] as const);
    const { rerender } = render(
      <MantineProvider>
        <WorkActions id="x" state="parked" cancel={noop} redispatch={noop} />
      </MantineProvider>,
    );
    expect(screen.getByRole('button', { name: /Redispatch/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
    rerender(
      <MantineProvider>
        <WorkActions id="x" state="done" cancel={noop} redispatch={noop} />
      </MantineProvider>,
    );
    expect(screen.queryByRole('button', { name: /Redispatch/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });
});
