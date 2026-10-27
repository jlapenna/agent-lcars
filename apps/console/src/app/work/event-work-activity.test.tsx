import type { ItemView } from '@agent-lcars/work/derive';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EventWorkActivity, WorkSourceEvents } from './event-work-activity';

describe('source activity', () => {
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
