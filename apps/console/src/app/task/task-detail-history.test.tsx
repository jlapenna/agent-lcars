import type { TaskId } from '@agent-lcars/orchestrator';
import type { ItemView } from '@agent-lcars/work/derive';
import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TaskDetailHistory } from './task-detail-history';

const item: ItemView = {
  id: 'work-or-github-key',
  state: 'parked',
  spec: {
    title: 'Retention',
    description: 'Choose retention.',
    pipeline: 'codex',
    target: { repo: 'jlapenna/agent-lcars' },
  },
  origin: { principal: 'github:jlapenna', channel: 'github' },
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T01:00:00Z',
  runs: [
    {
      runId: 'r1',
      pipeline: 'codex',
      state: 'finished',
      createdAt: '2026-10-09T00:00:00Z',
      updatedAt: '2026-10-09T00:30:00Z',
      result: {
        ok: true,
        summary: 'park',
        message: 'Which window?',
        ref: 'https://github.com/jlapenna/agent-lcars/pull/1',
      },
    },
    {
      runId: 'r2',
      pipeline: 'codex',
      state: 'finished',
      createdAt: '2026-10-09T00:30:00Z',
      updatedAt: '2026-10-09T01:00:00Z',
      reply: '30 days.',
      replyChannel: 'console',
      replyPrincipal: 'github:jlapenna',
      result: { ok: true, summary: 'park', ref: 'javascript:alert(1)' },
    },
  ],
  sessions: [
    {
      sessionId: 'session/a',
      runId: 'r1',
      title: 'Retention discussion',
      startedAt: '2026-10-09T00:00:00Z',
      lastActivityAt: '2026-10-09T00:30:00Z',
    },
  ],
};

for (const anchor of [
  { workId: 'native-id' },
  { repo: 'jlapenna/agent-lcars', issue: 2184 },
] satisfies TaskId[]) {
  describe(`shared audit for ${JSON.stringify(anchor)}`, () => {
    it('shows rounds, provenance, sessions and safe deliverables on the same surface', () => {
      render(
        <MantineProvider>
          <TaskDetailHistory anchor={anchor} item={item} revision={3} />
        </MantineProvider>,
      );
      expect(screen.getByText('Choose retention.')).toBeInTheDocument();
      expect(screen.getByText('Which window?')).toBeInTheDocument();
      expect(screen.getByText('30 days.')).toBeInTheDocument();
      expect(screen.getByTestId('task-detail-provenance')).toHaveTextContent(
        'authoritative state rev 3',
      );
      expect(
        screen.getByRole('link', { name: 'Retention discussion' }),
      ).toHaveAttribute('href', '/sessions/session%2Fa');
      const deliverables = within(screen.getByTestId('task-deliverables'));
      expect(deliverables.getByRole('link')).toHaveAttribute(
        'href',
        'https://github.com/jlapenna/agent-lcars/pull/1',
      );
      expect(deliverables.getByText('javascript:alert(1)')).toBeInTheDocument();
      expect(deliverables.getAllByRole('link')).toHaveLength(1);
    });
  });
}
