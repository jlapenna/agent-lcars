import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../../lib/action-items';
import type { AuthoritativeTaskState } from '../../lib/authoritative-task-state';
import type { CliSession } from '../../lib/cli-sessions';
import { ClaimedIdleSection } from './claimed-idle-section';

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    number: 1,
    title: 'Stale claim',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/1',
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    actionTypes: [],
    labels: [],
    assigneeLogins: ['agent-lcars-bot'],
    ...overrides,
  };
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

function makeAuthoritativeState(
  overrides: Partial<AuthoritativeTaskState> = {},
): AuthoritativeTaskState {
  return {
    schema: 'agent-lcars.authoritative-task-state/v2',
    task: { repo: 'supersprinklesracing/sprinkles', issue: 5 },
    storageRevision: 1,
    updatedAt: '2026-07-18T00:00:00Z',
    runs: [],
    ...overrides,
  };
}

function renderSection(
  items: ActionItem[],
  cliSessions: CliSession[] = [],
  authoritativeStates?: Map<string, AuthoritativeTaskState>,
) {
  render(
    <MantineProvider>
      <ClaimedIdleSection
        items={items}
        cliSessions={cliSessions}
        authoritativeStates={authoritativeStates}
      />
    </MantineProvider>,
  );
}

describe('ClaimedIdleSection', () => {
  it('omits itself when there are no stale claims', () => {
    renderSection([]);
    expect(screen.queryByTestId('claimed-idle-section')).toBeNull();
  });

  it('renders one row per stale claim with its updated-at age', () => {
    renderSection([makeItem({ number: 5, title: 'Fix the thing' })]);
    expect(screen.getByText('Claimed but Idle (1)')).toBeTruthy();
    expect(screen.getByTestId('compact-item-5')).toHaveTextContent(
      '#5 Fix the thing',
    );
    expect(screen.getByTestId('compact-item-5')).toHaveTextContent(
      /updated .+ ago/,
    );
    expect(
      screen.getByRole('button', { name: 'More actions for #5' }),
    ).toBeTruthy();
  });

  it('shows the takeover copy action without exposing the raw command', () => {
    renderSection([
      makeItem({
        number: 5,
        takeoverCommand: '~/p/members/tools/claude-agent-session.sh resume x',
      }),
    ]);
    expect(
      screen.getByRole('button', { name: 'Copy takeover command' }),
    ).toBeTruthy();
    expect(
      screen.queryByText('~/p/members/tools/claude-agent-session.sh resume x'),
    ).toBeNull();
  });

  it('renders no takeover chip when the item has none', () => {
    renderSection([makeItem({ number: 5 })]);
    expect(
      screen.queryByRole('button', { name: 'Copy takeover command' }),
    ).toBeNull();
  });

  it('links to the most recent session that worked this item, even if ended/stale', () => {
    renderSection(
      [makeItem({ number: 5 })],
      [makeSession({ liveness: 'stale', pr: { number: 5, url: 'u' } })],
    );
    const link = screen.getByTestId('claimed-idle-session-link');
    expect(link).toHaveAttribute('href', '/sessions/session-1');
  });

  it('renders no session link when no session references the item', () => {
    renderSection(
      [makeItem({ number: 5 })],
      [makeSession({ pr: { number: 999, url: 'u' } })],
    );
    expect(screen.queryByTestId('claimed-idle-session-link')).toBeNull();
  });

  it('flags a stale-looking claim as actually locked when the orchestrator still shows a live run (#1015)', () => {
    const authoritativeStates = new Map([
      [
        'supersprinklesracing/sprinkles#5',
        makeAuthoritativeState({
          activeRunId: 'supersprinklesracing/sprinkles#5/r1',
          runs: [
            {
              runId: 'supersprinklesracing/sprinkles#5/r1',
              task: { repo: 'supersprinklesracing/sprinkles', issue: 5 },
              state: 'running',
              pipeline: 'claude',
              requestId: 'req-1',
              leaseExpiresAt: '2026-07-18T01:00:00Z',
              events: [],
              createdAt: '2026-07-18T00:00:00Z',
              updatedAt: '2026-07-18T00:00:00Z',
            },
          ],
        }),
      ],
    ]);
    renderSection([makeItem({ number: 5 })], [], authoritativeStates);

    const badge = screen.getByTestId('claimed-idle-active-run');
    expect(badge.textContent).toBe('locked · running');
  });

  it('renders no lock badge when the orchestrator has no active run for the item', () => {
    const authoritativeStates = new Map([
      ['supersprinklesracing/sprinkles#5', makeAuthoritativeState()],
    ]);
    renderSection([makeItem({ number: 5 })], [], authoritativeStates);
    expect(screen.queryByTestId('claimed-idle-active-run')).toBeNull();
  });

  it('renders no lock badge when no authoritative state was fetched at all', () => {
    renderSection([makeItem({ number: 5 })]);
    expect(screen.queryByTestId('claimed-idle-active-run')).toBeNull();
  });
});
