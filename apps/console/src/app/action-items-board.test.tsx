import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { CliSession } from '../lib/cli-sessions';
import {
  type BoardCard,
  BridgeSections,
  DecisionInbox,
} from './action-items-board';

// This suite exercises the board's tiering only - ActionItemCard and
// RetriggerButton pull in the 'use server' actions module (auth, firestore,
// GitHub client), which is out of scope here and tested on its own.
vi.mock('./action-item-card', () => ({
  ActionItemCard: ({ item }: { item: { number: number; title: string } }) => (
    <div data-testid="full-card">{`#${item.number} ${item.title}`}</div>
  ),
}));
vi.mock('./queue-workspace', () => ({
  QueueWorkspace: ({
    cards,
  }: {
    cards: Array<{ item: { number: number; title: string } }>;
  }) =>
    cards.length > 0 ? (
      <>
        {cards.map(({ item }) => (
          <div key={item.number} data-testid="full-card">
            #{item.number} {item.title}
          </div>
        ))}
      </>
    ) : (
      <div>Nothing needs you right now.</div>
    ),
}));
vi.mock('./retrigger-button', () => ({
  RetriggerButton: ({
    issueNumber,
    pipeline,
  }: {
    issueNumber: number;
    pipeline?: string;
  }) => (
    <button
      data-testid={`retrigger-${issueNumber}`}
      data-pipeline={pipeline ?? 'claude'}
    >
      Retrigger
    </button>
  ),
}));
vi.mock('./item-overflow-menu', () => ({
  ItemOverflowMenu: ({ item }: { item: { number: number } }) => (
    <button data-testid={`overflow-${item.number}`}>More actions</button>
  ),
}));

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/1',
    updatedAt: '2026-07-07T00:00:00Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

function card(item: ActionItem): BoardCard {
  return { item };
}

function makeSession(overrides: Partial<CliSession> = {}): CliSession {
  return {
    sessionId: 'session-1',
    liveness: 'ended',
    agent: 'claude-code',
    turns: 1,
    totalTokens: 100,
    startedAt: '2026-07-18T00:00:00Z',
    lastActivityAt: '2026-07-18T00:00:00Z',
    ...overrides,
  };
}

function renderBoard({
  waitingOnDeploy = [],
  rest = [],
  cliSessions = [],
}: {
  waitingOnDeploy?: ActionItem[];
  rest?: ActionItem[];
  cliSessions?: CliSession[];
}) {
  render(
    <MantineProvider>
      <BridgeSections
        waitingOnDeploy={waitingOnDeploy.map(card)}
        rest={rest.map(card)}
        cliSessions={cliSessions}
      />
    </MantineProvider>,
  );
}

describe('Decision Inbox and Bridge surfaces', () => {
  it('says so when both Deck sections are empty instead of rendering nothing', () => {
    renderBoard({});
    expect(screen.getByTestId('deck-sections-empty')).toBeTruthy();
  });

  it('drops the empty note as soon as either section has items', () => {
    renderBoard({ waitingOnDeploy: [makeItem({ number: 7 })] });
    expect(screen.queryByTestId('deck-sections-empty')).toBeNull();
  });

  it('shows the empty-queue message when nothing needs the maintainer', () => {
    render(
      <MantineProvider>
        <DecisionInbox yourQueue={[]} />
      </MantineProvider>,
    );
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
  });

  it('keeps full decision cards on the Inbox surface', () => {
    render(
      <MantineProvider>
        <DecisionInbox
          yourQueue={[
            card(
              makeItem({
                number: 1,
                title: 'Answer me',
                actionTypes: ['needs-human'],
              }),
            ),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByTestId('full-card')).toHaveTextContent('#1 Answer me');
  });

  it('renders only compact secondary tiers on the Bridge', () => {
    renderBoard({
      waitingOnDeploy: [
        makeItem({
          number: 2,
          title: 'Verify after deploy',
          actionTypes: ['post-deploy-action'],
        }),
      ],
      rest: [makeItem({ number: 3, title: 'Background item' })],
    });

    expect(screen.queryByTestId('full-card')).toBeNull();
    expect(screen.getByTestId('compact-item-2')).toBeTruthy();
    expect(screen.getByTestId('compact-item-3')).toBeTruthy();
  });

  it('hides the deploy and catch-all tiers entirely when empty', () => {
    renderBoard({});
    expect(screen.queryByText(/Waiting on Next Deploy/)).toBeNull();
    expect(screen.queryByText(/Everything Else/)).toBeNull();
  });

  it('renders consistent two-line headings with counts in the description', () => {
    renderBoard({
      waitingOnDeploy: [makeItem({ number: 5 }), makeItem({ number: 6 })],
    });

    expect(
      screen.getByRole('heading', { name: 'Waiting on Next Deploy' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        '2 items · Verified and closed automatically after the affected app’s next deploy.',
      ),
    ).toBeTruthy();
  });

  it('offers the overflow menu on every compact row', () => {
    renderBoard({
      waitingOnDeploy: [
        makeItem({
          number: 7,
          title: 'Verify after deploy',
          actionTypes: ['post-deploy-action'],
        }),
      ],
      rest: [makeItem({ number: 6, title: 'Background item' })],
    });

    expect(screen.getByTestId('overflow-7')).toBeTruthy();
    expect(screen.getByTestId('overflow-6')).toBeTruthy();
  });

  it('flags a fleet-claimed backlog item and offers its takeover command', () => {
    renderBoard({
      rest: [
        makeItem({
          number: 9,
          title: 'Claimed backlog item',
          assigneeLogins: ['jclaw-bot'],
          takeoverCommand: '~/p/members/tools/claude-agent-session.sh resume x',
        }),
      ],
    });

    expect(screen.getByTestId('compact-item-9')).toHaveTextContent(
      'claimed by the fleet',
    );
    expect(
      screen.getByText('~/p/members/tools/claude-agent-session.sh resume x'),
    ).toBeTruthy();
    expect(screen.queryByTestId('everything-else-session-link')).toBeNull();
  });

  it('links a fleet-claimed item to the session that last worked it', () => {
    renderBoard({
      rest: [
        makeItem({
          number: 9,
          assigneeLogins: ['jclaw-bot'],
        }),
      ],
      cliSessions: [
        makeSession({
          sessionId: 'abc123',
          pr: { number: 9, url: 'https://github.com/o/r/pull/9' },
        }),
      ],
    });

    const link = screen.getByTestId('everything-else-session-link');
    expect(link).toHaveAttribute('href', '/sessions/abc123');
  });

  it('does not badge an unclaimed backlog item as fleet-claimed', () => {
    renderBoard({ rest: [makeItem({ number: 9 })] });

    expect(screen.getByTestId('compact-item-9')).not.toHaveTextContent(
      'claimed by the fleet',
    );
    expect(screen.queryByTestId('everything-else-session-link')).toBeNull();
  });

  it('keeps Everything Else collapsed by default with its rows still reachable', () => {
    renderBoard({ rest: [makeItem({ number: 6, title: 'Background item' })] });

    const details = screen.getByTestId('everything-else');
    expect(details).not.toHaveProperty('open', true);
    expect(screen.getByText(/Everything Else \(1\)/)).toBeTruthy();
    expect(
      within(details as HTMLElement).getByTestId('compact-item-6'),
    ).toBeTruthy();
  });
});
