import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('offers a checked-by-default resume checkbox when a resumeCandidate exists', async () => {
    const redispatch = vi.fn().mockResolvedValue([null, {}]);
    render(
      <MantineProvider>
        <WorkActions
          id="ID1"
          state="parked"
          cancel={vi.fn().mockResolvedValue([null, {}])}
          redispatch={redispatch}
          resumeCandidate={{ sessionId: 'sess_1', title: 'Prior turn' }}
        />
      </MantineProvider>,
    );
    expect(screen.getByText(/Resume from session/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Redispatch/i }));
    await waitFor(() =>
      expect(redispatch).toHaveBeenCalledWith({
        id: 'ID1',
        resumeSessionId: 'sess_1',
      }),
    );
  });

  it('omits resumeSessionId once the checkbox is unchecked', async () => {
    const redispatch = vi.fn().mockResolvedValue([null, {}]);
    render(
      <MantineProvider>
        <WorkActions
          id="ID1"
          state="parked"
          cancel={vi.fn().mockResolvedValue([null, {}])}
          redispatch={redispatch}
          resumeCandidate={{ sessionId: 'sess_1' }}
        />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Redispatch/i }));
    await waitFor(() => expect(redispatch).toHaveBeenCalledWith({ id: 'ID1' }));
  });

  it('renders no resume checkbox with no resumeCandidate', () => {
    render(
      <MantineProvider>
        <WorkActions
          id="ID1"
          state="parked"
          cancel={vi.fn()}
          redispatch={vi.fn()}
        />
      </MantineProvider>,
    );
    expect(screen.queryByText(/Resume from session/i)).not.toBeInTheDocument();
  });
});
