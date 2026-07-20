import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionLedger } from '../../lib/session-ledger';
import { LedgerTables } from './ledger-tables';

function renderLedger(ledger: SessionLedger) {
  render(
    <MantineProvider>
      <LedgerTables ledger={ledger} />
    </MantineProvider>,
  );
}

// Below `sm`, each ledger table renders a Turns/Cost-dropped compact variant
// alongside the full one (#3107); both branches render unconditionally in
// jsdom (which doesn't evaluate the visibleFrom/hiddenFrom CSS media queries
// that keep only one visible in a real browser), so content shared by both
// - the issue/week label itself - appears twice and needs getAllBy* rather
// than getBy*. Turns/Cost values are full-table-only, so those assertions
// are unaffected.
describe('LedgerTables', () => {
  it('renders nothing when both ledgers are empty', () => {
    renderLedger({ byIssue: [], byWeek: [] });
    expect(screen.queryByTestId('session-ledger')).toBeNull();
  });

  it('links a real issue number and labels the no-issue bucket in plain text, in both the full and compact tables', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 42, sessions: 2, turns: 10, tokens: 3000, costUsd: 1.5 },
        { issueNumber: 'no-issue', sessions: 1, turns: 3, tokens: 500 },
      ],
      byWeek: [],
    });

    const links = screen.getAllByRole('link', { name: '#42' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe(
        'https://github.com/supersprinklesracing/members/issues/42',
      );
    }
    expect(screen.getAllByText('no issue')).toHaveLength(2);
  });

  it('renders week rows with their ISO week key, in both the full and compact tables', () => {
    renderLedger({
      byIssue: [],
      byWeek: [{ isoWeek: '2026-W29', sessions: 3, turns: 12, tokens: 4000 }],
    });

    expect(screen.getAllByText('2026-W29')).toHaveLength(2);
  });

  it('shows an em-dash for a bucket with no recorded cost, and a formatted total for one that has it (full table only - the compact table drops the Cost column)', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 'no-issue', sessions: 1, turns: 1, tokens: 100 },
        { issueNumber: 7, sessions: 1, turns: 1, tokens: 100, costUsd: 2.5 },
      ],
      byWeek: [],
    });

    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('$2.50')).toBeTruthy();
  });

  it('caps each table at the top 15 rows in both the full and compact variants', () => {
    const byIssue = Array.from({ length: 20 }, (_, i) => ({
      issueNumber: i + 1,
      sessions: 1,
      turns: 1,
      tokens: 100 - i, // descending so the sort order is stable
      costUsd: 20 - i,
    }));
    renderLedger({ byIssue, byWeek: [] });

    expect(screen.getAllByTestId('ledger-issue-row')).toHaveLength(15);
    expect(screen.getAllByTestId('ledger-issue-row-compact')).toHaveLength(15);
  });

  it('renders the partial-cost footnote', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 'no-issue', sessions: 1, turns: 1, tokens: 100 },
      ],
      byWeek: [],
    });

    expect(screen.getByText(/partial dollar figure/)).toBeTruthy();
  });

  it('drops Turns and Cost from the compact per-issue table', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 42, sessions: 2, turns: 10, tokens: 3000, costUsd: 1.5 },
      ],
      byWeek: [],
    });

    const compactRow = screen.getByTestId('ledger-issue-row-compact');
    expect(compactRow.textContent).not.toContain('1.5');
    expect(compactRow.textContent).not.toContain('$1.50');
    // Sessions (2) and Tokens (3,000) still show; Turns (10) does not appear
    // as its own cell since the compact row omits that column entirely.
    expect(compactRow.querySelectorAll('td')).toHaveLength(3);
  });

  it('drops Turns and Cost from the compact per-week table', () => {
    renderLedger({
      byIssue: [],
      byWeek: [{ isoWeek: '2026-W29', sessions: 3, turns: 12, tokens: 4000 }],
    });

    const compactRow = screen.getByTestId('ledger-week-row-compact');
    expect(compactRow.querySelectorAll('td')).toHaveLength(3);
  });
});
