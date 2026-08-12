import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionRow } from '../../lib/session-archive';
import type { IssueSessionGroup } from '../../lib/session-issue-groups';
import { IssueGroupedSessions } from './issue-grouped-sessions';

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'session-1',
    source: 'cli',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    agent: 'claude-code',
    title: 'Fix flaky login test',
    prUrls: [],
    turns: 4,
    totalTokens: 1500,
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    liveness: 'ended',
    ...overrides,
  };
}

function renderGroups(groups: IssueSessionGroup[]) {
  render(
    <MantineProvider>
      <IssueGroupedSessions groups={groups} />
    </MantineProvider>,
  );
}

// SessionTable renders both a desktop table and a mobile card list
// unconditionally in jsdom (see session-table.test.tsx's own note), so any
// row content it renders inside a group appears twice here too.
describe('IssueGroupedSessions', () => {
  it('renders the same empty state as the flat table with no groups', () => {
    renderGroups([]);
    expect(screen.getByTestId('session-table-empty')).toBeTruthy();
    expect(screen.queryByTestId('issue-grouped-sessions')).toBeNull();
  });

  it('labels a real issue group with its number and links it to the issue', () => {
    renderGroups([
      {
        issueNumber: 42,
        repo: { owner: 'o', name: 'r' },
        issueUrl: 'https://github.com/o/r/issues/42',
        sessions: [makeRow()],
      },
    ]);

    const link = screen.getByRole('link', { name: '#42' });
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/issues/42');
  });

  it('shows the issue title next to the issue number when present', () => {
    renderGroups([
      {
        issueNumber: 175,
        repo: { owner: 'o', name: 'r' },
        issueUrl: 'https://github.com/o/r/issues/175',
        issueTitle: 'Include issue title in sessions by-issue item',
        sessions: [makeRow()],
      },
    ]);

    expect(
      screen.getByText('Include issue title in sessions by-issue item'),
    ).toBeTruthy();
  });

  it('renders no title text when the group has none', () => {
    renderGroups([
      {
        issueNumber: 42,
        repo: { owner: 'o', name: 'r' },
        issueUrl: 'https://github.com/o/r/issues/42',
        sessions: [makeRow()],
      },
    ]);

    expect(screen.getByRole('link', { name: '#42' })).toBeTruthy();
  });

  it('labels the no-issue group in plain text with no link', () => {
    renderGroups([
      {
        issueNumber: 'no-issue',
        sessions: [makeRow()],
      },
    ]);

    expect(screen.getByText('No issue')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '#42' })).toBeNull();
  });

  it('shows the correct session count per group, singular and plural', () => {
    renderGroups([
      {
        issueNumber: 1,
        repo: { owner: 'o', name: 'r' },
        sessions: [makeRow({ sessionId: 's1' })],
      },
      {
        issueNumber: 2,
        repo: { owner: 'o', name: 'r' },
        sessions: [makeRow({ sessionId: 's2' }), makeRow({ sessionId: 's3' })],
      },
    ]);

    expect(screen.getByText('1 session')).toBeTruthy();
    expect(screen.getByText('2 sessions')).toBeTruthy();
  });

  it('renders every session row within its own group, reusing SessionTable', () => {
    renderGroups([
      {
        issueNumber: 1,
        repo: { owner: 'o', name: 'r' },
        sessions: [
          makeRow({ sessionId: 's1', title: 'First session' }),
          makeRow({ sessionId: 's2', title: 'Second session' }),
        ],
      },
    ]);

    expect(screen.getAllByRole('link', { name: 'First session' })).toHaveLength(
      2,
    );
    expect(
      screen.getAllByRole('link', { name: 'Second session' }),
    ).toHaveLength(2);
  });

  it('starts the no-issue group collapsed, with its sessions hidden', () => {
    renderGroups([
      {
        issueNumber: 'no-issue',
        sessions: [makeRow({ title: 'Ad-hoc CLI session' })],
      },
    ]);

    expect(screen.getByText('No issue')).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: 'Ad-hoc CLI session' }),
    ).toBeNull();
  });

  it('expands the no-issue group on click, and re-collapses on a second click', () => {
    renderGroups([
      {
        issueNumber: 'no-issue',
        sessions: [makeRow({ title: 'Ad-hoc CLI session' })],
      },
    ]);

    const toggle = screen.getByTestId('no-issue-group-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getAllByRole('link', { name: 'Ad-hoc CLI session' }),
    ).toHaveLength(2);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      screen.queryByRole('link', { name: 'Ad-hoc CLI session' }),
    ).toBeNull();
  });

  it("renders a real issue group's sessions unconditionally, with no collapse toggle", () => {
    renderGroups([
      {
        issueNumber: 42,
        repo: { owner: 'o', name: 'r' },
        sessions: [makeRow({ title: 'Fix flaky login test' })],
      },
    ]);

    expect(
      screen.getAllByRole('link', { name: 'Fix flaky login test' }),
    ).toHaveLength(2);
    expect(screen.queryByTestId('no-issue-group-toggle')).toBeNull();
  });

  it('renders one section per group, in the order given', () => {
    renderGroups([
      {
        issueNumber: 5,
        repo: { owner: 'o', name: 'r' },
        sessions: [makeRow()],
      },
      { issueNumber: 'no-issue', sessions: [makeRow({ sessionId: 's2' })] },
    ]);

    const container = screen.getByTestId('issue-grouped-sessions');
    const headings = container.querySelectorAll('h3');
    expect(Array.from(headings).map((h) => h.textContent)).toEqual([
      '#5',
      'No issue',
    ]);
  });

  it('marks issue groups after the newest five for the mobile disclosure', () => {
    renderGroups(
      Array.from({ length: 10 }, (_, index) => ({
        issueNumber: index + 1,
        repo: { owner: 'o', name: 'r' },
        sessions: [
          makeRow({ sessionId: `s${index + 1}`, issueNumber: index + 1 }),
        ],
      })),
    );

    const disclosure = screen.getByTestId('issue-grouped-sessions');
    expect(
      disclosure.querySelectorAll('[data-mobile-history-extra="true"]'),
    ).toHaveLength(5);

    const toggle = screen.getByRole('button', {
      name: 'Show 5 older issue groups',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure).toHaveAttribute('data-expanded', 'true');
    expect(toggle).toHaveTextContent('Show fewer issue groups');
  });
});
