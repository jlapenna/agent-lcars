import type { ItemView, WorkSummary } from '@agent-lcars/work/derive';
import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EventWorkActivity, WorkSourceEvents } from './event-work-activity';

function eventSummary(index: number): WorkSummary {
  const workId = `01M5XRB7S5BMR0W8KGCSXJJ${String(index).padStart(3, '0')}`;
  return {
    id: workId,
    anchor: { workId },
    state: 'done',
    spec: {
      title: `Event ${index}`,
      description: 'Read-only',
      pipeline: 'opencode',
      target: { repo: 'jlapenna/homelab' },
    },
    origin: { principal: 'svc:fleet-triage', channel: 'github' },
    createdAt: '2026-10-27T04:00:00Z',
    updatedAt: '2026-10-27T05:00:00Z',
    runs: [
      {
        runId: `work:${workId}/r1`,
        pipeline: 'opencode',
        state: 'finished',
        createdAt: '2026-10-27T04:00:00Z',
        updatedAt: '2026-10-27T04:30:00Z',
        sourceRevision: { key: 'a', input: { operation: 'fleet-triage:v1' } },
      },
    ],
  } as WorkSummary;
}

describe('source activity', () => {
  it('lists the newest events and discloses every other match with a true count', () => {
    render(
      <MantineProvider>
        <EventWorkActivity
          items={Array.from({ length: 14 }, (_, i) => eventSummary(i + 1))}
          windowSize={200}
          windowed
        />
      </MantineProvider>,
    );
    const panel = screen.getByRole('region', { name: 'Event-driven work' });
    expect(panel).toHaveTextContent('14+');
    const remainder = screen.getByTestId('event-work-remainder');
    expect(remainder).toHaveTextContent(
      'Showing 10 of 14 · show 4 more event-driven tasks',
    );
    expect(within(remainder).getAllByRole('link')).toHaveLength(4);
    expect(
      within(remainder).getByRole('link', { name: 'Event 14' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /^Event \d+$/ })).toHaveLength(
      14,
    );
    expect(panel).toHaveTextContent(
      'Matches among the 200 most recently updated tasks.',
    );
  });

  it('preserves Bridge scope when opening event-driven Work', () => {
    render(
      <MantineProvider>
        <EventWorkActivity
          items={[]}
          repo="jlapenna/homelab"
          view={{ agent: 'opencode', window: '24h', q: 'health' }}
        />
      </MantineProvider>,
    );
    const href = screen
      .getByRole('link', { name: 'View event-driven work →' })
      .getAttribute('href');
    const query = new URL(href!, 'https://lcars.jlapenna.net').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      activity: 'events',
      repo: 'jlapenna/homelab',
      agent: 'opencode',
      window: '24h',
      q: 'health',
    });
  });

  it('retains failed attempts and links the published report to its issue', () => {
    const item: ItemView = {
      id: '01M5XRB7S5BMR0W8KGCSXJJDCF',
      state: 'done',
      spec: {
        title: 'Triage',
        description: 'Read-only',
        pipeline: 'opencode',
        target: { repo: 'jlapenna/homelab' },
      },
      origin: { principal: 'svc:fleet-triage', channel: 'github' },
      createdAt: '2026-10-27T04:00:00Z',
      updatedAt: '2026-10-27T05:00:00Z',
      sessions: [],
      runs: [
        {
          runId: 'work:x/r1',
          pipeline: 'opencode',
          state: 'finished',
          createdAt: '2026-10-27T04:00:00Z',
          updatedAt: '2026-10-27T04:30:00Z',
          revisionAttempt: 1,
          sourceRevision: {
            key: 'a',
            input: {
              operation: 'fleet-triage:v1',
              repo: 'jlapenna/homelab',
              issue: 3018,
            },
          },
          result: { ok: false, summary: 'invalid-triage-report' },
        },
        {
          runId: 'work:x/r2',
          pipeline: 'opencode',
          state: 'finished',
          createdAt: '2026-10-27T04:30:00Z',
          updatedAt: '2026-10-27T05:00:00Z',
          revisionAttempt: 2,
          sourceRevision: {
            key: 'a',
            input: {
              operation: 'fleet-triage:v1',
              repo: 'jlapenna/homelab',
              issue: 3018,
            },
          },
          result: { ok: true, summary: 'report' },
          triagePublication: { state: 'complete', commentId: 123 },
        },
      ],
    };
    item.runs.unshift({
      ...item.runs[0]!,
      runId: 'work:x/r0',
      result: { ok: true, summary: 'superseded' },
    });
    render(
      <MantineProvider>
        <WorkSourceEvents item={item} />
      </MantineProvider>,
    );
    expect(screen.getByText(/· Superseded/)).toBeInTheDocument();
    expect(screen.queryByText(/Succeeded: superseded/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Failed: invalid-triage-report/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Publication complete/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Published triage report ↗' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/jlapenna/homelab/issues/3018#issuecomment-123',
    );
    expect(
      screen.getAllByRole('link', { name: 'View attempt details' }),
    ).toHaveLength(3);
  });
});
