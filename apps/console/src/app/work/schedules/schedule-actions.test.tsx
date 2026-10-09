import { MantineProvider } from '@mantine/core';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleActions } from './schedule-actions';
import type { EditableSchedule } from './schedule-create-form';

const { refresh, notify } = vi.hoisted(() => ({
  refresh: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: notify } }));
const schedule: EditableSchedule = {
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  cron: '0 * * * *',
  enabled: true,
  revision: 7,
  spec: {
    title: 'Hourly audit',
    description: 'Review work',
    pipeline: 'claude',
    target: { repo: 'jlapenna/agent-lcars' },
  },
};
function setup() {
  refresh.mockClear();
  notify.mockClear();
  const actions = {
    enable: vi.fn().mockResolvedValue([null, {}]),
    disable: vi.fn().mockResolvedValue([null, {}]),
    update: vi.fn().mockResolvedValue([null, {}]),
    remove: vi.fn().mockResolvedValue([null, {}]),
  };
  const element = (current = schedule) => (
    <MantineProvider>
      <ScheduleActions schedule={current} {...actions} />
    </MantineProvider>
  );
  return { ...render(element()), actions, element };
}

describe('schedule edit/delete controls', () => {
  it('requires explicit deletion confirmation and freezes the revision selected before refresh', async () => {
    const { actions, rerender, element } = setup();
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete', exact: true }),
    );
    expect(actions.remove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete schedule?',
    });
    expect(
      within(dialog).getByText(/already admitted occurrence may still finish/),
    ).toBeVisible();
    rerender(
      element({
        ...schedule,
        revision: 8,
        spec: { ...schedule.spec!, title: 'New title' },
      }),
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete schedule' }),
    );
    await waitFor(() =>
      expect(actions.remove).toHaveBeenCalledWith({
        id: schedule.id,
        expectedRevision: 7,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('canceling deletion leaves the schedule intact', async () => {
    const { actions } = setup();
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete', exact: true }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(actions.remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['returned', 'transport'])(
    'keeps a failed deletion visible (%s failure)',
    async (kind) => {
      const { actions } = setup();
      if (kind === 'returned')
        actions.remove.mockResolvedValue([
          { code: 'CONFLICT', message: 'Schedule changed; reload' },
          null,
        ]);
      else actions.remove.mockRejectedValue(new Error('Connection lost'));
      fireEvent.click(
        screen.getByRole('button', { name: 'Delete', exact: true }),
      );
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Delete schedule' }),
      );
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        kind === 'returned' ? 'Schedule changed; reload' : 'Connection lost',
      );
      expect(refresh).not.toHaveBeenCalled();
      expect(notify.mock.calls.some(([input]) => input.color === 'green')).toBe(
        false,
      );
      expect(screen.getByRole('button', { name: 'Disable' })).toBeVisible();
    },
  );

  it('edits the selected spec and submits its captured revision despite refreshed rows', async () => {
    const { actions, rerender, element } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit schedule' });
    expect(within(dialog).getByLabelText(/^Title/)).toHaveValue('Hourly audit');
    expect(within(dialog).getByLabelText(/Cron/)).toHaveValue('0 * * * *');
    rerender(element({ ...schedule, revision: 8 }));
    fireEvent.change(within(dialog).getByLabelText(/^Title/), {
      target: { value: 'Edited audit' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Cron/), {
      target: { value: '15 9 * * *' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save changes' }),
    );
    await waitFor(() =>
      expect(actions.update).toHaveBeenCalledWith({
        id: schedule.id,
        expectedRevision: 7,
        cron: '15 9 * * *',
        enabled: true,
        spec: { ...schedule.spec, title: 'Edited audit' },
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('preserves unsaved edit input and shows a rejected revision without success', async () => {
    const { actions } = setup();
    actions.update.mockResolvedValue([
      { code: 'CONFLICT', message: 'Schedule changed; reload before editing' },
      null,
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Title/), {
      target: { value: 'Unsaved' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save changes' }),
    );
    expect(
      await within(dialog).findByText(
        'Schedule changed; reload before editing',
      ),
    ).toBeVisible();
    expect(within(dialog).getByLabelText(/^Title/)).toHaveValue('Unsaved');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('sends a revision with toggles and reports transport failures inline', async () => {
    const { actions } = setup();
    actions.disable.mockRejectedValue(new Error('Network unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Network unavailable',
    );
    expect(actions.disable).toHaveBeenCalledWith({
      id: schedule.id,
      expectedRevision: 7,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(['success', 'refusal'])(
    'keeps a pending edit mounted until its %s is visible',
    async (outcome) => {
      const { actions } = setup();
      let resolve!: (result: unknown) => void;
      actions.update.mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Edit schedule',
      });
      fireEvent.change(within(dialog).getByLabelText(/^Title/), {
        target: { value: 'Pending draft' },
      });
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Save changes' }),
      );
      await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
      fireEvent.keyDown(within(dialog).getByLabelText(/^Title/), {
        key: 'Escape',
        code: 'Escape',
      });
      expect(
        screen.getByRole('dialog', { name: 'Edit schedule' }),
      ).toBeVisible();
      expect(
        screen.getByRole('button', { name: 'Delete', exact: true }),
      ).toBeDisabled();
      expect(within(dialog).getByLabelText(/^Title/)).toBeDisabled();
      resolve(
        outcome === 'success'
          ? [null, {}]
          : [{ code: 'CONFLICT', message: 'Concurrent change refused' }, null],
      );
      await waitFor(() =>
        expect(refresh.mock.calls.length).toBe(outcome === 'success' ? 1 : 0),
      );
      const failure =
        outcome === 'refusal'
          ? await within(dialog).findByText('Concurrent change refused')
          : undefined;
      expect(failure?.textContent).toBe(
        outcome === 'refusal' ? 'Concurrent change refused' : undefined,
      );
    },
  );
});
