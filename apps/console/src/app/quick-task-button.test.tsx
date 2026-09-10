import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
  await screen.findByRole('dialog');
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

  it('automatically retries the same work id after the live-run cap', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    (createItem as Mock)
      .mockResolvedValueOnce([
        {
          code: 'TOO_MANY_REQUESTS',
          message: 'At cap',
          data: { retryAfterSeconds: 1 },
        },
        undefined,
      ])
      .mockResolvedValueOnce([undefined, { id: 'created' }]);
    renderButton();
    await submit();
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    const scheduledIndex = setTimeoutSpy.mock.calls.findLastIndex(
      ([, delay]) => delay === 1000,
    );
    expect(scheduledIndex).toBeGreaterThanOrEqual(0);
    const [retry] = setTimeoutSpy.mock.calls[scheduledIndex];
    clearTimeout(setTimeoutSpy.mock.results[scheduledIndex].value);
    setTimeoutSpy.mockRestore();
    await act(async () => (retry as () => void)());
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(2));
    expect((createItem as Mock).mock.calls[1][0].id).toBe(
      (createItem as Mock).mock.calls[0][0].id,
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
      'repository',
      'requestId',
      'source',
      'workId',
    ]);
    expect(wireIntent).not.toHaveProperty('file');
    expect(createItem).not.toHaveBeenCalled();
  });
});
