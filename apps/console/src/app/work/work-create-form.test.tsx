import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it.each([
    ['FORBIDDEN', 'no grant for that pipeline or repository'],
    ['TOO_MANY_REQUESTS', 'live-run cap reached'],
  ])('renders %s inline', async (code, text) => {
    renderForm(vi.fn().mockResolvedValue([{ code, message: 'x' }, null]));
    fillTitleAndDescription('T', 'D');
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });
});
