import type { ItemView } from '@agent-lcars/work/derive';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Conversation } from './conversation';

const baseItem: ItemView = {
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  state: 'parked',
  spec: {
    title: 'Add a widget',
    description: 'Add a new UI widget.',
    pipeline: 'claude',
    target: { repo: 'jlapenna/agent-lcars' },
  },
  origin: { principal: 'user:jlapenna', channel: 'api' },
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:05:00.000Z',
  runs: [],
  sessions: [],
};

const itemWithTwoRounds: ItemView = {
  ...baseItem,
  runs: [
    {
      runId: 'work:x/r1',
      state: 'finished',
      pipeline: 'claude',
      createdAt: '2026-08-26T10:00:00.000Z',
      updatedAt: '2026-08-26T10:05:00.000Z',
      result: {
        ok: true,
        summary: 'park',
        message: 'Which database should I use?',
      },
    },
    {
      runId: 'work:x/r2',
      state: 'finished',
      pipeline: 'claude',
      createdAt: '2026-08-26T10:10:00.000Z',
      updatedAt: '2026-08-26T10:15:00.000Z',
      reply: 'Use Firestore.',
      replyChannel: 'console',
      replyPrincipal: 'user:jlapenna',
      result: {
        ok: true,
        summary: 'park',
        message: 'Confirmed: using Firestore.',
      },
    },
  ],
};

const itemWithLiveRound: ItemView = {
  ...baseItem,
  state: 'running',
  runs: [
    {
      runId: 'work:x/r1',
      state: 'running',
      pipeline: 'claude',
      createdAt: '2026-08-26T10:00:00.000Z',
      updatedAt: '2026-08-26T10:00:00.000Z',
    },
  ],
};

function renderConversation(item: ItemView) {
  render(
    <MantineProvider>
      <Conversation item={item} />
    </MantineProvider>,
  );
}

describe('Conversation', () => {
  it('renders round one as the spec description and each reply round as a turn pair', () => {
    renderConversation(itemWithTwoRounds);
    // round 1: the human turn is the item's own description
    expect(screen.getByText('Add a new UI widget.')).toBeInTheDocument();
    expect(
      screen.getByText('Which database should I use?'),
    ).toBeInTheDocument();
    // round 2: the reply and the agent's answer
    expect(screen.getByText('Use Firestore.')).toBeInTheDocument();
    expect(screen.getAllByText(/user:jlapenna/).length).toBeGreaterThan(0);
    expect(screen.getByText('Confirmed: using Firestore.')).toBeInTheDocument();
  });

  it('renders a round with no agent message without an empty agent bubble', () => {
    renderConversation(itemWithLiveRound);
    expect(screen.queryByTestId('agent-turn')).not.toBeInTheDocument();
  });
});
