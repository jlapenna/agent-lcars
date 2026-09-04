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
        <WorkActions
          id="x"
          state="parked"
          cancel={noop}
          redispatch={noop}
          reply={noop}
        />
      </MantineProvider>,
    );
    expect(screen.getByRole('button', { name: /Redispatch/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
    rerender(
      <MantineProvider>
        <WorkActions
          id="x"
          state="done"
          cancel={noop}
          redispatch={noop}
          reply={noop}
        />
      </MantineProvider>,
    );
    expect(screen.queryByRole('button', { name: /Redispatch/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  it('offers no actions at all while a run is live', () => {
    const noop = vi.fn(async () => [null, undefined] as const);
    const { container } = render(
      <MantineProvider>
        <WorkActions
          id="x"
          state="running"
          cancel={noop}
          redispatch={noop}
          reply={noop}
        />
      </MantineProvider>,
    );
    // Cancel is offered while running; reply is not (there is nothing yet
    // to answer), and nothing else renders unexpectedly.
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Reply/ })).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('offers a reply box on a parked item and calls reply({ id, text })', async () => {
    const reply = vi.fn().mockResolvedValue([null, { resumed: true }]);
    render(
      <MantineProvider>
        <WorkActions
          id="ID1"
          state="parked"
          cancel={vi.fn()}
          redispatch={vi.fn()}
          reply={reply}
        />
      </MantineProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Use Firestore.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Reply/i }));
    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ id: 'ID1', text: 'Use Firestore.' }),
    );
  });

  it('offers a reply box on a done item too -- "one more tweak"', () => {
    render(
      <MantineProvider>
        <WorkActions
          id="ID1"
          state="done"
          cancel={vi.fn()}
          redispatch={vi.fn()}
          reply={vi.fn()}
        />
      </MantineProvider>,
    );
    expect(screen.getByRole('button', { name: /Reply/i })).toBeInTheDocument();
  });

  it('surfaces a subdued note when the reply response reports resumed: false', async () => {
    const reply = vi.fn().mockResolvedValue([null, { resumed: false }]);
    render(
      <MantineProvider>
        <WorkActions
          id="ID1"
          state="parked"
          cancel={vi.fn()}
          redispatch={vi.fn()}
          reply={reply}
        />
      </MantineProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'try again' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Reply/i }));
    await waitFor(() =>
      expect(screen.getByText(/started a fresh session/i)).toBeInTheDocument(),
    );
  });
});
