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

// Below `sm`, each ledger renders a flat, Turns/Cost-weighted-token-dropped
// list alongside the full semantic table. Both branches render in jsdom
// (which doesn't evaluate the media queries that keep only one visible in a
// browser), so shared issue/week labels appear twice.
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
        'https://github.com/supersprinklesracing/sprinkles/issues/42',
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

  it('shows an em-dash for a bucket with no recorded cost, and a formatted total for one that has it, in both the full and compact tables', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 'no-issue', sessions: 1, turns: 1, tokens: 100 },
        { issueNumber: 7, sessions: 1, turns: 1, tokens: 100, costUsd: 2.5 },
      ],
      byWeek: [],
    });

    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getAllByText('$2.50')).toHaveLength(2);
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

  it('prefixes an estimated cost total with ~ and leaves a fully-measured total unmarked', () => {
    renderLedger({
      byIssue: [
        {
          issueNumber: 7,
          sessions: 1,
          turns: 1,
          tokens: 100,
          costUsd: 3.5,
          costEstimated: true,
        },
        {
          issueNumber: 8,
          sessions: 1,
          turns: 1,
          tokens: 100,
          costUsd: 2.5,
        },
      ],
      byWeek: [],
    });

    expect(screen.getAllByText('~$3.50')).toHaveLength(2);
    expect(screen.getAllByText('$2.50')).toHaveLength(2);
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

  it('drops Turns and cost-weighted tokens from the compact per-issue table, but keeps Cost (#203)', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 42, sessions: 2, turns: 10, tokens: 3000, costUsd: 1.5 },
      ],
      byWeek: [],
    });

    const compactRow = screen.getByTestId('ledger-issue-row-compact');
    expect(compactRow.textContent).toContain('$1.50');
    expect(compactRow.textContent).not.toContain('3,000');
    expect(compactRow.textContent).toContain('2 sessions');
  });

  it('drops Turns and cost-weighted tokens from the compact per-week table, but keeps Cost (#203)', () => {
    renderLedger({
      byIssue: [],
      byWeek: [
        {
          isoWeek: '2026-W29',
          sessions: 3,
          turns: 12,
          tokens: 4000,
          costUsd: 6,
        },
      ],
    });

    const compactRow = screen.getByTestId('ledger-week-row-compact');
    expect(compactRow.textContent).toContain('$6.00');
    expect(compactRow.textContent).not.toContain('4,000');
    expect(compactRow.textContent).toContain('3 sessions');
  });
});
