import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { QuickTaskButton } from './quick-task-button';
import { createItem, createItemWithEvidence } from './work/actions';

vi.mock('./work/actions', () => ({
  createItem: vi.fn(),
  createItemWithEvidence: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn(), update: vi.fn() },
}));

const REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

function renderButton() {
  render(
    <MantineProvider>
      <QuickTaskButton watchedRepos={[REPO]} />
    </MantineProvider>,
  );
}

async function submit(description = 'Fix the flaky test') {
  fireEvent.click(await screen.findByRole('button', { name: 'New work' }));
  // First activation compiles/loads the lazy dialog in the Node test runtime.
  await screen.findByRole('dialog', undefined, { timeout: 5_000 });
  fireEvent.change(await screen.findByLabelText('Description'), {
    target: { value: description },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
}

describe('New work creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/agents');
    (createItem as Mock).mockResolvedValue([undefined, { id: 'created' }]);
  });

  it('creates one repository-explicit native work item', async () => {
    renderButton();
    await submit();
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    expect(createItem).toHaveBeenCalledWith({
      id: expect.any(String),
      spec: expect.objectContaining({
        title: 'Fix the flaky test',
        pipeline: 'claude',
        priority: 'normal',
        target: { repo: 'supersprinklesracing/sprinkles' },
      }),
    });
    expect(notifications.update).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'green' }),
    );
  });

  it('keeps source context in the native item description', async () => {
    renderButton();
    await submit('Investigate this screen');
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    expect((createItem as Mock).mock.calls[0][0].spec.description).toContain(
      'Console route: `/agents`',
    );
  });

  it('keeps a draft when the lazily loaded dialog is dismissed and reopened', async () => {
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'New work' }));
    await screen.findByRole('dialog', undefined, { timeout: 5_000 });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Keep this draft' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), {
      target: { value: 'background' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'New work' }));
    await screen.findByRole('dialog');
    expect(screen.getByLabelText('Description')).toHaveValue('Keep this draft');
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue(
      'background',
    );
    expect(createItem).not.toHaveBeenCalled();
  });

  it('retains the same trigger and captures the click route before lazy loading', async () => {
    renderButton();
    const trigger = await screen.findByRole('button', { name: 'New work' });
    fireEvent.click(trigger);
    window.history.replaceState(null, '', '/inbox');
    await screen.findByRole('dialog', undefined, { timeout: 5_000 });
    expect(screen.getByRole('button', { name: 'New work' })).toBe(trigger);
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Investigate the originating page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    expect((createItem as Mock).mock.calls[0][0].spec.description).toContain(
      'Console route: `/agents`',
    );
  });

  it('submits the selected urgent priority without changing provider', async () => {
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'New work' }));
    await screen.findByRole('dialog');
    const selector = screen.getByRole('combobox', { name: 'Priority' });
    fireEvent.change(selector, { target: { value: 'urgent' } });
    expect(selector).toHaveValue('urgent');
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Urgent fix' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    expect((createItem as Mock).mock.calls[0][0].spec).toMatchObject({
      priority: 'urgent',
      pipeline: 'claude',
    });
  });

  it('retries the frozen urgent request while the next draft resets to normal', async () => {
    (createItem as Mock)
      .mockResolvedValueOnce([{ message: 'Response lost' }, undefined])
      .mockResolvedValueOnce([undefined, { id: 'created' }]);
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'New work' }));
    await screen.findByRole('dialog', undefined, { timeout: 5_000 });
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), {
      target: { value: 'urgent' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Urgent request with a lost response' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    await waitFor(() => expect(notifications.update).toHaveBeenCalled());
    const failure = vi
      .mocked(notifications.update)
      .mock.calls.find(([notification]) => notification.color === 'red');
    expect(failure).toBeDefined();
    if (!failure) throw new Error('Expected the retry notification');
    render(<MantineProvider>{failure[0].message}</MantineProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(2));
    expect((createItem as Mock).mock.calls[1][0]).toEqual(
      (createItem as Mock).mock.calls[0][0],
    );
    expect((createItem as Mock).mock.calls[1][0].spec.priority).toBe('urgent');
    fireEvent.click(screen.getByRole('button', { name: 'New work' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue(
      'normal',
    );
  });

  it('uses the evidence-aware native action for an attachment', async () => {
    (createItemWithEvidence as Mock).mockResolvedValue([
      undefined,
      { id: 'created' },
    ]);
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'New work' }));
    await screen.findByRole('dialog');
    fireEvent.change(await screen.findByLabelText('Description'), {
      target: { value: 'Inspect screenshot' },
    });
    const file = new File(['image'], 'screen.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Screenshot file'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    await waitFor(() =>
      expect(createItemWithEvidence).toHaveBeenCalledTimes(1),
    );
    const submitted = (createItemWithEvidence as Mock).mock
      .calls[0][0] as FormData;
    expect(submitted.get('evidence')).toBe(file);
    const rawIntent = submitted.get('intent');
    expect(typeof rawIntent).toBe('string');
    const wireIntent = JSON.parse(rawIntent as string) as Record<
      string,
      unknown
    >;
    expect(Object.keys(wireIntent).sort()).toEqual([
      'description',
      'evidenceId',
      'pipeline',
      'priority',
      'repository',
      'requestId',
      'source',
      'workId',
    ]);
    expect(wireIntent).not.toHaveProperty('file');
    expect(wireIntent.priority).toBe('normal');
    expect(createItem).not.toHaveBeenCalled();
  });
});
