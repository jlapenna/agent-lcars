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
    // Continued sidechain merged into the trailing sidechain-group rather than
    // creating a second disclosure block.
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

  it('retains loaded events and allows retrying after a transient fetch error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }),
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
        'Failed to load more transcript events',
      );
    });
    expect(screen.getByText('Page 1 turn')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('transcript-load-more'));
    await waitFor(() => {
      expect(screen.getByText('Recovered!')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('transcript-warning')).toBeNull();
  });
});
