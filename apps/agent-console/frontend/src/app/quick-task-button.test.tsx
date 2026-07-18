import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { createQuickTask } from './actions';
import { QuickTaskButton } from './quick-task-button';

vi.mock('./actions', () => ({
  createQuickTask: vi.fn(),
}));

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

function renderButton() {
  render(
    <MantineProvider>
      <QuickTaskButton />
    </MantineProvider>,
  );
}

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Quick task' }));
  return screen.findByRole('dialog');
}

describe('QuickTaskButton', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens a full screen dialog rather than an inline dropdown', async () => {
    renderButton();

    const dialog = await openDialog();

    expect(screen.getByText('File a quick task')).toBeTruthy();
    expect(dialog.getAttribute('data-full-screen')).toBe('true');
  });

  it('disables File & dispatch until a description is entered', async () => {
    renderButton();
    await openDialog();

    const dispatchButton = screen.getByRole('button', {
      name: 'File & dispatch',
    }) as HTMLButtonElement;
    expect(dispatchButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Fix the flaky test' },
    });

    expect(dispatchButton.disabled).toBe(false);
  });

  it('files the task with a blank title, letting the backend derive one', async () => {
    (createQuickTask as Mock).mockResolvedValue({
      ok: true,
      url: 'https://github.com/x/y/issues/99',
      number: 99,
    });
    renderButton();
    await openDialog();

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Fix the flaky test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'File & dispatch' }));

    await waitFor(() =>
      expect(createQuickTask).toHaveBeenCalledWith('Fix the flaky test', ''),
    );
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Quick task filed as #99',
        color: 'green',
      }),
    );
  });

  it('forwards an explicit title when one is entered', async () => {
    (createQuickTask as Mock).mockResolvedValue({
      ok: true,
      url: 'https://github.com/x/y/issues/99',
      number: 99,
    });
    renderButton();
    await openDialog();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Custom title' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Fix the flaky test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'File & dispatch' }));

    await waitFor(() =>
      expect(createQuickTask).toHaveBeenCalledWith(
        'Fix the flaky test',
        'Custom title',
      ),
    );
  });

  it('surfaces a failed dispatch as a red notification', async () => {
    (createQuickTask as Mock).mockResolvedValue({
      ok: false,
      message: 'Task description is required',
    });
    renderButton();
    await openDialog();

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Fix the flaky test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'File & dispatch' }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Task description is required',
          color: 'red',
        }),
      ),
    );
  });
});
