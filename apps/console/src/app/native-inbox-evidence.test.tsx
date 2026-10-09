import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getNativeInboxEvidence } from '../lib/native-inbox';
import { DeckInboxSummary } from './deck-inbox-summary';

beforeEach(() =>
  vi.spyOn(console, 'error').mockImplementation(() => undefined),
);

// Exercise the actual optional read boundary and its Bridge signpost.
describe('Bridge native Inbox evidence', () => {
  it.each(['context', 'tasks', 'runs'])(
    'preserves GitHub navigation when %s rejects',
    async (failure) => {
      const store = new MemoryStore();
      if (failure === 'tasks')
        vi.spyOn(store, 'listNativeTasks').mockRejectedValue(
          new Error('tasks unavailable'),
        );
      if (failure === 'runs') {
        await new Orchestrator(store, {
          now: () => '2026-10-09T00:00:00Z',
        }).request({
          taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
          requestId: 'evidence-run-read',
          pipeline: 'claude',
          work: {
            origin: { principal: 'user:maintainer', channel: 'console' },
            spec: {
              title: 'Native work',
              description: 'Read evidence',
              pipeline: 'claude',
              target: { repo: 'jlapenna/agent-lcars' },
            },
          },
        });
        vi.spyOn(store, 'listRuns').mockRejectedValue(
          new Error('runs unavailable'),
        );
      }
      const evidence = await getNativeInboxEvidence(async () => {
        if (failure === 'context') throw new Error('context unavailable');
        return { store, principal: undefined };
      });
      expect(evidence.available).toBe(false);
      expect(evidence.warnings).toEqual([
        expect.stringContaining('GitHub decisions only'),
      ]);
      render(
        <MantineProvider>
          <DeckInboxSummary
            count={2 + evidence.cards.length}
            nativeAvailable={evidence.available}
            inboxHref="/inbox?repo=agent%2Flcars"
          />
        </MantineProvider>,
      );
      expect(screen.getByTestId('deck-inbox-summary')).toHaveTextContent(
        '2GitHub decisions waiting',
      );
      expect(screen.getByTestId('deck-inbox-summary')).toHaveTextContent(
        'native unavailable',
      );
      expect(
        screen.getByRole('link', { name: 'Review queue' }),
      ).toHaveAttribute('href', '/inbox?repo=agent%2Flcars');
    },
  );

  it('distinguishes an available empty native queue from missing evidence', async () => {
    const evidence = await getNativeInboxEvidence(async () => ({
      store: new MemoryStore(),
      principal: undefined,
    }));
    expect(evidence).toEqual({ cards: [], available: true, warnings: [] });
  });
});
