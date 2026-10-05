import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EditWork } from './edit-work';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function renderEdit(update = vi.fn(async () => [null, undefined] as const)) {
  render(
    <MantineProvider>
      <EditWork
        id="x"
        title="Old title"
        description="Old description"
        running={false}
        update={update}
      />
    </MantineProvider>,
  );
  return update;
}

describe('EditWork', () => {
  it('renders nothing while a run is live', () => {
    render(
      <MantineProvider>
        <EditWork
          id="x"
          title="t"
          description="d"
          running
          update={vi.fn(async () => [null, undefined] as const)}
        />
      </MantineProvider>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('saves the edited title and description', async () => {
    const update = renderEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'New title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        id: 'x',
        title: 'New title',
        description: 'Old description',
      }),
    );
  });

  it('refuses an empty title', () => {
    renderEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: ' ' },
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
