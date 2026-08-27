import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleCreateForm } from './schedule-create-form';

function renderForm(create = vi.fn()) {
  render(
    <MantineProvider>
      <ScheduleCreateForm
        create={create}
        defaultRepo="jlapenna/agent-lcars"
        pipelines={['claude', 'codex']}
      />
    </MantineProvider>,
  );
  return create;
}

describe('ScheduleCreateForm', () => {
  it('submits { id, cron, spec, enabled } with a ulid id', async () => {
    const create = renderForm(vi.fn().mockResolvedValue([null, { id: 'X' }]));
    fireEvent.change(screen.getByLabelText(/^Title/), {
      target: { value: 'Nightly sync' },
    });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Run the nightly sync.' },
    });
    fireEvent.change(screen.getByLabelText(/Cron/), {
      target: { value: '0 3 * * *' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [input] = create.mock.calls[0];
    expect(input.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(input.cron).toBe('0 3 * * *');
    expect(input.enabled).toBe(true);
    expect(input.spec).toEqual({
      title: 'Nightly sync',
      description: 'Run the nightly sync.',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    });
  });

  it('rejects an invalid cron expression client-side without calling create', async () => {
    const create = renderForm();
    fireEvent.change(screen.getByLabelText(/^Title/), {
      target: { value: 'T' },
    });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'D' },
    });
    fireEvent.change(screen.getByLabelText(/Cron/), {
      target: { value: 'not a cron' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    expect(
      await screen.findByText(/valid 5-field UTC cron expression/),
    ).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([['FORBIDDEN', 'no grant for that pipeline or repository']])(
    'renders %s inline',
    async (code, text) => {
      renderForm(vi.fn().mockResolvedValue([{ code, message: 'x' }, null]));
      fireEvent.change(screen.getByLabelText(/^Title/), {
        target: { value: 'T' },
      });
      fireEvent.change(screen.getByLabelText(/^Description/), {
        target: { value: 'D' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
      expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
    },
  );

  it('renders a server BAD_REQUEST message inline (a syntactically valid cron client-side `parseCron` cannot itself catch, e.g. one that never fires)', async () => {
    // Not in the `REFUSALS` lookup, so the raw server message is shown
    // verbatim -- the exact message `schedule-router.ts`'s create handler
    // throws for a cron expression that parses but has no due slot within
    // a year (e.g. `0 0 31 2 *`, no February has a 31st).
    const create = renderForm(
      vi.fn().mockResolvedValue([
        {
          code: 'BAD_REQUEST',
          message: 'cron expression never fires within a year',
        },
        null,
      ]),
    );
    fireEvent.change(screen.getByLabelText(/^Title/), {
      target: { value: 'T' },
    });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'D' },
    });
    fireEvent.change(screen.getByLabelText(/Cron/), {
      target: { value: '0 0 31 2 *' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    expect(
      await screen.findByText('cron expression never fires within a year'),
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
