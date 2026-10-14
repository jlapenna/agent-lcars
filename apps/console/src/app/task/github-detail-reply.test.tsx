import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../../lib/action-items';
import {
  configureTestWatchedRepos,
  TEST_SPRINKLES_REPOSITORY,
} from '../../test-support/watched-repos';
import { replyToItem, retryReplyToItem } from '../actions';
import { GithubDetailReply } from './github-detail-reply';

vi.mock('../actions', () => ({
  replyToItem: vi.fn(),
  retryReplyToItem: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const item = {
  repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
  number: 42,
  kind: 'issue',
  labels: ['agent:codex'],
} as ActionItem;

beforeEach(() => {
  configureTestWatchedRepos([TEST_SPRINKLES_REPOSITORY]);
  vi.mocked(replyToItem).mockReset();
  vi.mocked(retryReplyToItem).mockReset();
});

describe('GitHub detail reply boundary', () => {
  it('posts a reply through the GitHub admission path with its assigned pipeline', async () => {
    vi.mocked(replyToItem).mockResolvedValue({
      ok: true,
      dispatched: true,
      note: 'Dispatched codex',
    });
    render(
      <MantineProvider>
        <GithubDetailReply item={item} />
      </MantineProvider>,
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Reply to the agent' }),
      { target: { value: 'Use Firestore.' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() =>
      expect(replyToItem).toHaveBeenCalledWith(
        item.repo,
        42,
        'Use Firestore.',
        'codex',
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Dispatched codex',
    );
  });

  it('offers a retry after a posted reply fails dispatch, without reposting it', async () => {
    vi.mocked(replyToItem).mockResolvedValue({
      ok: true,
      dispatched: false,
      warning: true,
      note: 'Reply posted, but dispatch failed.',
      retry: { commentId: 123, pipeline: 'codex' },
    });
    vi.mocked(retryReplyToItem)
      .mockResolvedValueOnce({ ok: false, message: 'Dispatch unavailable' })
      .mockResolvedValueOnce({ ok: true, note: 'Dispatched codex' });
    render(
      <MantineProvider>
        <GithubDetailReply item={item} />
      </MantineProvider>,
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Reply to the agent' }),
      { target: { value: 'Use Firestore.' } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry dispatch' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dispatch unavailable',
    );
    expect(screen.getByRole('textbox')).toHaveValue('');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry dispatch' }));
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Retry dispatch' }),
      ).not.toBeInTheDocument(),
    );
    expect(retryReplyToItem).toHaveBeenCalledWith(item.repo, 42, 123, 'codex');
    expect(replyToItem).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText('Reply posted, but dispatch failed.'),
    ).not.toBeInTheDocument();
  });

  it('retains a refused reply and displays the admission error', async () => {
    vi.mocked(replyToItem).mockResolvedValue({
      ok: false,
      message: 'task-busy',
    });
    render(
      <MantineProvider>
        <GithubDetailReply item={item} />
      </MantineProvider>,
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Reply to the agent' }),
      { target: { value: 'Keep this reply.' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('task-busy');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this reply.');
  });
});
