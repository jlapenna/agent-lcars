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

describe('LedgerTables', () => {
  it('renders nothing when both ledgers are empty', () => {
    renderLedger({ byIssue: [], byWeek: [] });
    expect(screen.queryByTestId('session-ledger')).toBeNull();
  });

  it('links a real issue number and labels the no-issue bucket in plain text', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 42, sessions: 2, turns: 10, tokens: 3000, costUsd: 1.5 },
        { issueNumber: 'no-issue', sessions: 1, turns: 3, tokens: 500 },
      ],
      byWeek: [],
    });

    const link = screen.getByRole('link', { name: '#42' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/supersprinklesracing/members/issues/42',
    );
    expect(screen.getByText('no issue')).toBeTruthy();
  });

  it('renders week rows with their ISO week key', () => {
    renderLedger({
      byIssue: [],
      byWeek: [{ isoWeek: '2026-W29', sessions: 3, turns: 12, tokens: 4000 }],
    });

    expect(screen.getByText('2026-W29')).toBeTruthy();
  });

  it('shows an em-dash for a bucket with no recorded cost, and a formatted total for one that has it', () => {
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

  it('caps each table at the top 15 rows', () => {
    const byIssue = Array.from({ length: 20 }, (_, i) => ({
      issueNumber: i + 1,
      sessions: 1,
      turns: 1,
      tokens: 100 - i, // descending so the sort order is stable
      costUsd: 20 - i,
    }));
    renderLedger({ byIssue, byWeek: [] });

    expect(screen.getAllByTestId('ledger-issue-row')).toHaveLength(15);
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
});
