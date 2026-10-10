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
  it('allows an explicitly background schedule', async () => {
    const create = renderForm(vi.fn().mockResolvedValue([null, { id: 'X' }]));
    fireEvent.change(screen.getByLabelText(/^Title/), {
      target: { value: 'Nightly' },
    });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Background maintenance' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(await screen.findByRole('option', { name: 'background' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0].spec).toMatchObject({
      priority: 'background',
      pipeline: 'claude',
    });
  });
  it('preserves an urgent edit draft and releases pending state after transport refusal', async () => {
    let rejectSave!: (error: Error) => void;
    const create = vi.fn(
      (_input: unknown) =>
        new Promise<never>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const onPendingChange = vi.fn();
    const onSaved = vi.fn();
    render(
      <MantineProvider>
        <ScheduleCreateForm
          create={create}
          defaultRepo="other/repo"
          initial={{
            id: 'existing',
            revision: 7,
            cron: '0 3 * * *',
            enabled: false,
            spec: {
              title: 'Existing urgent',
              description: 'Keep this draft',
              pipeline: 'codex',
              priority: 'urgent',
              target: { repo: 'o/r' },
            },
          }}
          onPendingChange={onPendingChange}
          onSaved={onSaved}
        />
      </MantineProvider>,
    );
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue(
      'urgent',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      cron: '0 3 * * *',
      enabled: false,
      spec: {
        title: 'Existing urgent',
        description: 'Keep this draft',
        pipeline: 'codex',
        priority: 'urgent',
        target: { repo: 'o/r' },
      },
    });
    expect(screen.getByRole('combobox', { name: 'Priority' })).toBeDisabled();
    rejectSave(new Error('Transport refused'));
    expect(await screen.findByText('Transport refused')).toBeInTheDocument();
    await waitFor(() =>
      expect(onPendingChange).toHaveBeenLastCalledWith(false),
    );
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue(
      'urgent',
    );
    expect(screen.getByLabelText(/^Description/)).toHaveValue(
      'Keep this draft',
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

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
      priority: 'normal',
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
