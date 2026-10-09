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
  it.each(['parked', 'failed'] as const)(
    'offers redispatch for %s and cancel unless settled',
    (state) => {
      const noop = vi.fn(async () => [null, undefined] as const);
      const { rerender } = render(
        <MantineProvider>
          <WorkActions
            id="x"
            state={state}
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
    },
  );

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
    const reply = vi.fn().mockResolvedValue([
      null,
      {
        id: 'ID1',
        spec: { title: 'Choose decision storage' },
        admittedRunId: 'work:ID1/r2',
        resumed: true,
      },
    ]);
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

  it.each([
    { state: 'parked', resumed: false },
    { state: 'failed', resumed: false },
    { state: 'done', resumed: false },
    { state: 'parked', resumed: true },
    { state: 'failed', resumed: true },
    { state: 'done', resumed: true },
  ] as const)(
    'retains $state reply admission (resumed: $resumed) only for its accepted item and round',
    async ({ state, resumed }) => {
      const reply = vi.fn().mockResolvedValue([
        null,
        {
          id: 'ID1',
          spec: { title: 'Choose decision storage' },
          admittedRunId: 'work:ID1/r2',
          resumed,
        },
      ]);
      const props = {
        id: 'ID1',
        latestRunId: 'work:ID1/r1',
        cancel: vi.fn(),
        redispatch: vi.fn(),
        reply,
      };
      const { rerender } = render(
        <MantineProvider>
          <WorkActions {...props} state={state} />
        </MantineProvider>,
      );
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'Use Firestore.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Reply/i }));
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
      // Apply the real refresh's new state; a permanently parked test would
      // miss the original regression, which hid the note behind canReply.
      rerender(
        <MantineProvider>
          <WorkActions {...props} state="running" latestRunId="work:ID1/r2" />
        </MantineProvider>,
      );
      expect(screen.getByRole('status')).toHaveTextContent(
        resumed
          ? /saved transcript.*Resume will be attempted/
          : /fresh session.*no resumable transcript/,
      );
      expect(screen.getByTestId('work-reply-confirmation')).toHaveTextContent(
        'Choose decision storage',
      );
      expect(screen.queryByRole('textbox')).toBeNull();
      // Even retaining the old round id must not attribute this ack to ID2.
      rerender(
        <MantineProvider>
          <WorkActions
            {...props}
            id="ID2"
            state="running"
            latestRunId="work:ID1/r2"
          />
        </MantineProvider>,
      );
      expect(screen.queryByRole('status')).toBeNull();
      // A later admission of the original item must not reuse the old ack.
      rerender(
        <MantineProvider>
          <WorkActions {...props} state="running" latestRunId="work:ID1/r3" />
        </MantineProvider>,
      );
      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  it.each(['done', 'parked', 'failed'] as const)(
    'retains admission when the first refreshed accepted round is already %s',
    async (state) => {
      const reply = vi.fn().mockResolvedValue([
        null,
        {
          id: 'ID1',
          spec: { title: 'Choose decision storage' },
          admittedRunId: 'work:ID1/r2',
          resumed: false,
        },
      ]);
      const props = { id: 'ID1', cancel: vi.fn(), redispatch: vi.fn(), reply };
      const { rerender } = render(
        <MantineProvider>
          <WorkActions {...props} state="parked" latestRunId="work:ID1/r1" />
        </MantineProvider>,
      );
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'Finish this quickly.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Reply/i }));
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
      // Never observe running: the accepted round finishes before refresh.
      rerender(
        <MantineProvider>
          <WorkActions {...props} state={state} latestRunId="work:ID1/r2" />
        </MantineProvider>,
      );
      expect(screen.getByRole('status')).toHaveTextContent(/fresh session/);
      rerender(
        <MantineProvider>
          <WorkActions {...props} state="canceled" latestRunId="work:ID1/r2" />
        </MantineProvider>,
      );
      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  it('does not attribute an accepted fresh reply to a newer round already in its response history', async () => {
    const response = [
      null,
      {
        id: 'ID1',
        spec: { title: 'Choose decision storage' },
        admittedRunId: 'work:ID1/r2',
        resumed: false,
        runs: [{ runId: 'work:ID1/r2' }, { runId: 'work:ID1/r3' }],
      },
    ] as const;
    let finish: (value: typeof response) => void = () => undefined;
    const reply = vi.fn(
      () =>
        new Promise<typeof response>((resolve) => {
          finish = resolve;
        }),
    );
    const props = { id: 'ID1', cancel: vi.fn(), redispatch: vi.fn(), reply };
    const { rerender } = render(
      <MantineProvider>
        <WorkActions {...props} state="parked" latestRunId="work:ID1/r1" />
      </MantineProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Start fresh.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Reply/i }));
    // Another operator's r3 is visible before our r2 response arrives. Its
    // history is current, but resumed=false still describes r2 alone.
    rerender(
      <MantineProvider>
        <WorkActions {...props} state="running" latestRunId="work:ID1/r3" />
      </MantineProvider>,
    );
    finish(response);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeEnabled(),
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/fresh session/)).toBeNull();
  });

  it('keeps a refused reply editable without admission confirmation', async () => {
    const reply = vi
      .fn()
      .mockResolvedValue([
        { code: 'CONFLICT', message: 'task-busy' },
        undefined,
      ]);
    render(
      <MantineProvider>
        <WorkActions
          id="ID1"
          latestRunId="work:ID1/r1"
          state="parked"
          cancel={vi.fn()}
          redispatch={vi.fn()}
          reply={reply}
        />
      </MantineProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Keep my refused draft.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Reply/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Reply/i })).toBeEnabled(),
    );
    expect(screen.getByRole('textbox')).toHaveValue('Keep my refused draft.');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
