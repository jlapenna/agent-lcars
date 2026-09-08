import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkCreateForm } from './work-create-form';

// 'use client' component needs an app router context - mocked the same way
// work-actions.test.tsx / refresh-button.test.tsx do, since no
// <AppRouterContext.Provider> is mounted in this render.
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function renderForm(create = vi.fn()) {
  render(
    <MantineProvider>
      <WorkCreateForm
        create={create}
        defaultRepo="jlapenna/agent-lcars"
        pipelines={['claude', 'codex']}
      />
    </MantineProvider>,
  );
  return create;
}

function fillTitleAndDescription(title: string, description: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
    target: { value: title },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
    target: { value: description },
  });
}

describe('WorkCreateForm', () => {
  it('submits { id, spec } with a ulid and navigates to the item', async () => {
    const create = renderForm(
      vi.fn().mockResolvedValue([null, { id: 'X', state: 'running' }]),
    );
    fillTitleAndDescription('Add healthz', 'Expose /healthz');
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [input] = create.mock.calls[0];
    expect(input.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(input.spec).toEqual({
      title: 'Add healthz',
      description: 'Expose /healthz',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/work/${input.id}`));
  });

  it('renders FORBIDDEN inline as a terminal error', async () => {
    renderForm(
      vi.fn().mockResolvedValue([{ code: 'FORBIDDEN', message: 'x' }, null]),
    );
    fillTitleAndDescription('T', 'D');
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    expect(
      await screen.findByText(/does not cover that pipeline or repository/),
    ).toBeInTheDocument();
  });

  it('queues instead of blocking on TOO_MANY_REQUESTS, then retries automatically', async () => {
    // Spies on the real `setTimeout` rather than switching to fake timers:
    // `useTransition`'s async work relies on the platform's own scheduler,
    // which fake timers fight with. Capturing the scheduled callback and
    // invoking it directly proves the same thing -- an automatic retry was
    // armed, unprompted, at the server's own delay -- without needing the
    // real 5 seconds to elapse.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const create = renderForm(
      vi
        .fn()
        .mockResolvedValueOnce([
          {
            code: 'TOO_MANY_REQUESTS',
            message: 'x',
            data: { retryAfterSeconds: 5 },
          },
          null,
        ])
        .mockResolvedValueOnce([null, { id: 'X', state: 'running' }]),
    );
    fillTitleAndDescription('Add healthz', 'Expose /healthz');
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/live-run cap/);
    // The button is free to use again, not stuck disabled for the whole
    // queued wait -- an impatient operator can still force an immediate
    // manual retry (see the id-reuse test below); nothing here does that,
    // so this exercises the automatic path only. The disabled/loading state
    // clears one render after the refusal text, same as the manual-retry
    // test below -- wait for the button itself.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create work item' }),
      ).not.toBeDisabled(),
    );

    const scheduled = setTimeoutSpy.mock.calls.find(
      ([, delay]) => delay === 5_000,
    );
    expect(scheduled).toBeDefined();
    const [retryCallback] = scheduled ?? [];
    setTimeoutSpy.mockRestore();

    // Simulate the scheduled wait elapsing, with no further user action.
    await act(async () => {
      (retryCallback as () => void)();
    });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0].id).toBe(create.mock.calls[0][0].id);
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/work/${create.mock.calls[0][0].id}`),
    );
  });

  it('reuses the same id on a manual retry (same fields) while queued', async () => {
    const create = renderForm(
      vi
        .fn()
        .mockResolvedValue([{ code: 'TOO_MANY_REQUESTS', message: 'x' }, null]),
    );
    fillTitleAndDescription('Add healthz', 'Expose /healthz');
    const submitButton = screen.getByRole('button', {
      name: 'Create work item',
    });

    fireEvent.click(submitButton);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const firstId: string = create.mock.calls[0][0].id;
    // The button's `disabled`/`data-loading` doesn't clear in the same
    // commit as the refusal text: React 19 keeps an async transition
    // pending until the whole callback's promise settles, one render
    // *after* the `setError` that paints the message - so wait for the
    // button itself, not just for the error to appear, or a fast retry
    // click lands on a still-disabled button and never resubmits.
    await waitFor(() => expect(submitButton).not.toBeDisabled());

    fireEvent.click(submitButton);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0].id).toBe(firstId);
  });

  it('mints a new id when the title changes after an error', async () => {
    const create = renderForm(
      vi
        .fn()
        .mockResolvedValue([{ code: 'TOO_MANY_REQUESTS', message: 'x' }, null]),
    );
    fillTitleAndDescription('Add healthz', 'Expose /healthz');
    const submitButton = screen.getByRole('button', {
      name: 'Create work item',
    });

    fireEvent.click(submitButton);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const firstId: string = create.mock.calls[0][0].id;
    await waitFor(() => expect(submitButton).not.toBeDisabled());

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Add healthz v2' },
    });
    fireEvent.click(submitButton);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0].id).not.toBe(firstId);
  });
});
