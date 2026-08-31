import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionRow } from '../../lib/session-archive';
import { SessionTable } from './session-table';

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

function renderTable(rows: SessionRow[]) {
  render(
    <MantineProvider>
      <SessionTable rows={rows} />
    </MantineProvider>,
  );
}

// Below `sm`, SessionTable renders a card list instead of the 12-column
// table (#3107); both branches render unconditionally in jsdom (which
// doesn't evaluate the visibleFrom/hiddenFrom CSS media queries that keep
// only one visible in a real browser - see InvitesTable.test.tsx for the
// same pattern elsewhere in this repo), so any row content shared by both
// views appears twice and needs getAllBy* rather than getBy*.
describe('SessionTable', () => {
  it('renders an empty state with no rows', () => {
    renderTable([]);
    expect(screen.getByTestId('session-table-empty')).toBeTruthy();
    expect(screen.queryByTestId('session-cards')).toBeNull();
  });

  it('links a row title to its session detail page in both views', () => {
    renderTable([makeRow({ sessionId: 'abc-123' })]);
    const links = screen.getAllByRole('link', { name: 'Fix flaky login test' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('/sessions/abc-123');
    }
  });

  it('links the issue number when present in both views', () => {
    renderTable([
      makeRow({
        source: 'issue-agent',
        issueNumber: 42,
        issueUrl: 'https://github.com/o/r/issues/42',
      }),
    ]);
    const links = screen.getAllByRole('link', { name: '#42' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe(
        'https://github.com/o/r/issues/42',
      );
    }
  });

  it('renders no issue link when the row has none', () => {
    renderTable([makeRow()]);
    expect(screen.queryByText('#42')).toBeNull();
  });

  it('keeps every PR in the desktop table but only the latest on the phone card', () => {
    renderTable([
      makeRow({
        prUrls: [
          { number: 10, url: 'https://github.com/o/r/pull/10' },
          { number: 20, url: 'https://github.com/o/r/pull/20' },
        ],
      }),
    ]);
    const pr10 = screen.getAllByRole('link', { name: '#10' });
    const pr20 = screen.getAllByRole('link', { name: '#20' });
    expect(pr10).toHaveLength(1);
    expect(pr20).toHaveLength(2);
    for (const link of pr10) {
      expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/10');
    }
    for (const link of pr20) {
      expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/20');
    }
    expect(screen.getByText('+1 earlier')).toBeTruthy();
  });

  it('shows the host for a CLI session in the table column', () => {
    renderTable([makeRow({ source: 'cli', host: 'joes-workstation' })]);
    expect(screen.getByText('joes-workstation')).toBeTruthy();
  });

  it('keeps host metadata in the desktop table and out of the phone card', () => {
    renderTable([
      makeRow({
        sessionId: 'card-host',
        source: 'cli',
        host: 'joes-workstation',
      }),
    ]);
    expect(screen.getAllByText('joes-workstation')).toHaveLength(1);
    expect(screen.queryByTestId('session-card-meta')).toBeNull();
  });

  it('links a historical numeric Actions run in the table only (dropped as card noise)', () => {
    renderTable([
      makeRow({
        source: 'issue-agent',
        runId: '999',
        runUrl: 'https://github.com/o/r/actions/runs/999',
      }),
    ]);
    const links = screen.getAllByRole('link', { name: /run/ });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(
      'https://github.com/o/r/actions/runs/999',
    );
  });

  it('renders an opaque native run ID as text when it has no Actions URL', () => {
    const runId = 'supersprinklesracing/sprinkles#42/r1';
    renderTable([
      makeRow({
        source: 'issue-agent',
        runId,
      }),
    ]);

    expect(screen.getByText(runId).closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /run/ })).toBeNull();
  });

  it('shows a formatted cost when the row has one', () => {
    renderTable([makeRow({ sessionId: 's-cost', totalCostUsd: 1.5 })]);
    expect(screen.getAllByText('$1.50').length).toBeGreaterThan(0);
  });

  it('shows an em-dash for cost when the row has none (table only - the card drops it entirely)', () => {
    renderTable([makeRow({ sessionId: 's-no-cost' })]);
    expect(screen.queryByText('$')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the liveness badge with its label in both views', () => {
    renderTable([makeRow({ liveness: 'live' })]);
    expect(screen.getByTestId('session-row-liveness').textContent).toBe('live');
    expect(screen.getByTestId('session-card-liveness').textContent).toBe(
      'live',
    );
  });

  it('formats total tokens with thousands separators', () => {
    renderTable([makeRow({ totalTokens: 12345 })]);
    expect(screen.getByText('12,345')).toBeTruthy();
    expect(screen.queryByText(/cw tok/)).toBeNull();
  });

  it('renders the explicit claude-code identity in both row views', () => {
    renderTable([makeRow({ agent: 'claude-code' })]);
    expect(screen.getAllByText('claude code')).toHaveLength(2);
  });

  it('renders the explicit codex identity in both row views', () => {
    renderTable([makeRow({ agent: 'codex' })]);
    expect(screen.getAllByText('codex')).toHaveLength(2);
  });

  it('renders the agent-declared status with its own age under the title in both views (#1257)', () => {
    renderTable([
      makeRow({
        liveness: 'live',
        status: 'waiting on CI for #1247',
        statusUpdatedAt: '2026-07-10T10:03:00.000Z',
      }),
    ]);

    expect(screen.getAllByText('waiting on CI for #1247')).toHaveLength(2);
    expect(screen.getAllByTestId('session-status-line')).toHaveLength(2);
  });

  it('hides the status line for an ended session even when a status is present (#1257)', () => {
    renderTable([
      makeRow({
        liveness: 'ended',
        status: 'waiting on CI for #1247',
        statusUpdatedAt: '2026-07-10T10:03:00.000Z',
      }),
    ]);

    expect(screen.queryByText('waiting on CI for #1247')).toBeNull();
    expect(screen.queryByTestId('session-status-line')).toBeNull();
  });

  it('renders no status line, and disturbs no other row content, when a row has no status (#1257)', () => {
    renderTable([makeRow({ liveness: 'live' })]);

    expect(screen.queryByTestId('session-status-line')).toBeNull();
    expect(
      screen.getAllByRole('link', { name: 'Fix flaky login test' }),
    ).toHaveLength(2);
  });

  it('truncates a long status instead of breaking the row (#1257)', () => {
    const longStatus =
      'a deliberately very long agent-declared status describing exactly ' +
      'what it is doing right now in far more detail than needed';
    renderTable([
      makeRow({
        liveness: 'live',
        status: longStatus,
        statusUpdatedAt: '2026-07-10T10:03:00.000Z',
      }),
    ]);

    const nodes = screen.getAllByText(longStatus);
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(node.getAttribute('data-truncate')).toBe('end');
    }
  });

  it("shows the status's own age, not the session's lastActivityAt (#1257)", () => {
    renderTable([
      makeRow({
        liveness: 'live',
        lastActivityAt: '2026-07-10T10:09:00.000Z',
        status: 'waiting on CI for #1247',
        statusUpdatedAt: '2026-07-10T09:30:00.000Z',
      }),
    ]);

    // RelativeTime renders client-side from `Date.now()` (see
    // relative-time.test.tsx) - assert the wiring by checking the <time>
    // under the status line carries statusUpdatedAt as its datetime, not
    // lastActivityAt.
    const statusLines = screen.getAllByTestId('session-status-line');
    for (const line of statusLines) {
      const time = line.querySelector('time');
      expect(time?.getAttribute('datetime')).toBe('2026-07-10T09:30:00.000Z');
    }
  });

  it('renders one card per row, scoped under the mobile card list', () => {
    renderTable([
      makeRow({ sessionId: 's1' }),
      makeRow({ sessionId: 's2', title: 'Second session' }),
    ]);
    expect(screen.getByTestId('session-card-s1')).toBeTruthy();
    expect(screen.getByTestId('session-card-s2')).toBeTruthy();
  });
});
