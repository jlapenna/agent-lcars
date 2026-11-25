import type { TranscriptTimelineEvent } from '@agent-lcars/telemetry';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaginatedTranscriptView } from './paginated-transcript-view';

vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown-stub">{children}</div>
  ),
}));
vi.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

describe('PaginatedTranscriptView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads subsequent pages incrementally, merges continued sidechains, and updates the panel count', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [
            {
              kind: 'sidechain-group',
              continuesPrevious: true,
              events: [{ kind: 'tool_result', content: 'subagent match 2' }],
            },
            { kind: 'text', role: 'assistant', text: 'Final summary.' },
          ],
          hasMore: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const initialEvents: TranscriptTimelineEvent[] = [
      { kind: 'text', role: 'user', text: 'Investigate' },
      {
        kind: 'sidechain-group',
        events: [{ kind: 'tool_use', name: 'Grep', inputJson: '{"q":"bug"}' }],
      },
    ];

    render(
      <MantineProvider>
        <PaginatedTranscriptView
          sessionId="session-42"
          initialEvents={initialEvents}
          initialNextCursor="cursor-page-2"
        />
      </MantineProvider>,
    );

    expect(screen.getByText('2+')).toBeInTheDocument();
    const button = screen.getByTestId('transcript-load-more');
    expect(button).toHaveStyle({ minHeight: '44px' });

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Final summary.')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/session-42/transcript?cursor=cursor-page-2',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
      }),
    );
    expect(screen.getAllByTestId('transcript-sidechain-group')).toHaveLength(1);
    expect(
      screen.getByText('subagent activity (2 events)'),
    ).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-load-more')).toBeNull();
  });

  it('preserves already-loaded events and surfaces expiry warnings on HTTP 410', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [],
          hasMore: false,
          warning: 'Transcript unavailable (archive retention expired).',
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <MantineProvider>
        <PaginatedTranscriptView
          sessionId="cli-1"
          initialEvents={[{ kind: 'text', role: 'user', text: 'Keep me' }]}
          initialNextCursor="cursor-2"
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByTestId('transcript-load-more'));

    await waitFor(() => {
      expect(screen.getByTestId('transcript-warning')).toHaveTextContent(
        'retention expired',
      );
    });
    expect(screen.getByText('Keep me')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-load-more')).toBeNull();
  });

  it('preserves loaded events and offers reload action on HTTP 409 snapshot replacement', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [],
          hasMore: false,
          code: 'snapshot-changed',
          warning:
            'Transcript snapshot changed since this page loaded. Reload to view the updated archive.',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <MantineProvider>
        <PaginatedTranscriptView
          sessionId="cli-1"
          initialEvents={[
            { kind: 'text', role: 'user', text: 'Snapshot 1 event' },
          ]}
          initialNextCursor="stale-cursor"
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByTestId('transcript-load-more'));

    await waitFor(() => {
      expect(screen.getByTestId('transcript-warning')).toHaveTextContent(
        'snapshot changed',
      );
    });
    expect(screen.getByText('Snapshot 1 event')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-load-more')).toBeNull();
    const reloadButton = screen.getByTestId('transcript-reload');
    expect(reloadButton).toHaveStyle({ minHeight: '44px' });
  });

  it('retains loaded events and allows retrying after a transient 503 storage error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Transcript storage unavailable',
            warning:
              'Failed to load more transcript events from storage. Try again.',
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            events: [{ kind: 'text', role: 'assistant', text: 'Recovered!' }],
            hasMore: false,
          }),
          { status: 200 },
        ),
      );

    render(
      <MantineProvider>
        <PaginatedTranscriptView
          sessionId="session-retry"
          initialEvents={[{ kind: 'text', role: 'user', text: 'Page 1 turn' }]}
          initialNextCursor="cursor-retry"
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByTestId('transcript-load-more'));
    await waitFor(() => {
      expect(screen.getByTestId('transcript-warning')).toHaveTextContent(
        'Failed to load more transcript events from storage. Try again.',
      );
    });
    expect(screen.getByText('Page 1 turn')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-load-more')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('transcript-load-more'));
    await waitFor(() => {
      expect(screen.getByText('Recovered!')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('transcript-warning')).toBeNull();
  });
});
