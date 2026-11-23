import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, type Mock, vi } from 'vitest';

import { getWatchedRepos } from '../../lib/github-client';
import type { SessionLedger } from '../../lib/session-ledger';
import { LedgerTables, MAX_DISCLOSED_ISSUE_ROWS } from './ledger-tables';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('../../lib/github-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../lib/github-client')>();
  return { ...actual, getWatchedRepos: vi.fn(actual.getWatchedRepos) };
});

function renderLedger(ledger: SessionLedger) {
  render(
    <MantineProvider>
      <LedgerTables ledger={ledger} />
    </MantineProvider>,
  );
}

// Below `sm`, each ledger renders a flat, Turns-dropped list alongside the
// full semantic table. Both branches render in jsdom
// (which doesn't evaluate the media queries that keep only one visible in a
// browser), so shared issue/week labels appear twice.
describe('LedgerTables', () => {
  it('renders nothing when both ledgers are empty', () => {
    renderLedger({ byIssue: [], byWeek: [] });
    expect(screen.queryByTestId('session-ledger')).toBeNull();
  });

  it('keeps every issue past the top rows one disclosure away', () => {
    renderLedger({
      byIssue: Array.from({ length: 18 }, (_, i) => ({
        issueNumber: i + 1,
        sessions: 1,
        turns: 2,
        tokens: 100,
        costUsd: 0.1,
      })),
      byWeek: [],
    });
    const remainder = screen.getByTestId('ledger-issue-remainder');
    expect(remainder.tagName).toBe('DETAILS');
    expect(remainder).not.toHaveAttribute('open');
    expect(within(remainder).getByText(/Showing 15 of 18/)).toHaveTextContent(
      'Showing 15 of 18 · show 3 more issues',
    );
    expect(within(remainder).getAllByTestId('ledger-issue-row')).toHaveLength(
      3,
    );
  });

  it('caps the disclosed issues and links to the full ledger', () => {
    const issues = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        issueNumber: i + 1,
        sessions: 1,
        turns: 2,
        tokens: 100,
        costUsd: 0.1,
      }));
    const total = 15 + MAX_DISCLOSED_ISSUE_ROWS + 20;
    const { unmount } = render(
      <MantineProvider>
        <LedgerTables
          ledger={{ byIssue: issues(total), byWeek: [] }}
          showAllIssuesHref="/costs?ledger=all"
        />
      </MantineProvider>,
    );
    let remainder = screen.getByTestId('ledger-issue-remainder');
    expect(remainder).not.toHaveAttribute('open');
    expect(within(remainder).getAllByTestId('ledger-issue-row')).toHaveLength(
      MAX_DISCLOSED_ISSUE_ROWS,
    );
    const link = within(remainder).getByTestId('ledger-issue-show-all');
    expect(link).toHaveAttribute('href', '/costs?ledger=all');
    expect(link).toHaveTextContent(`Show all ${total} issues (20 more)`);
    unmount();

    render(
      <MantineProvider>
        <LedgerTables
          ledger={{ byIssue: issues(total), byWeek: [] }}
          showAllIssues
          showAllIssuesHref="/costs?ledger=all"
        />
      </MantineProvider>,
    );
    remainder = screen.getByTestId('ledger-issue-remainder');
    expect(remainder).toHaveAttribute('open');
    expect(within(remainder).getAllByTestId('ledger-issue-row')).toHaveLength(
      total - 15,
    );
    expect(screen.queryByTestId('ledger-issue-show-all')).toBeNull();
  });

  it('renders no truncation note while the window still fits', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 1, sessions: 1, turns: 2, tokens: 100, costUsd: 0.1 },
      ],
      byWeek: [],
    });
    expect(screen.queryByTestId('ledger-issue-remainder')).toBeNull();
    expect(screen.queryByText(/Showing \d+ of \d+/)).toBeNull();
  });

  it('labels telemetry-only issue buckets as GitHub links without requiring a task projection, in both tables', () => {
    renderLedger({
      byIssue: [
        {
          issueNumber: 42,
          repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
          sessions: 2,
          turns: 10,
          tokens: 3000,
          costUsd: 1.5,
        },
        { issueNumber: 'no-issue', sessions: 1, turns: 3, tokens: 500 },
      ],
      byWeek: [],
    });

    const links = screen.getAllByRole('link', { name: 'GitHub #42' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe(
        'https://github.com/supersprinklesracing/sprinkles/issues/42',
      );
      expect(link).toHaveAttribute('target', '_blank');
    }
    expect(screen.queryByRole('link', { name: '#42' })).toBeNull();
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

  it('shows the top 15 rows and discloses the rest in both the full and compact variants', () => {
    const byIssue = Array.from({ length: 20 }, (_, i) => ({
      issueNumber: i + 1,
      sessions: 1,
      turns: 1,
      tokens: 100 - i, // descending so the sort order is stable
      costUsd: 20 - i,
    }));
    renderLedger({ byIssue, byWeek: [] });

    const remainder = screen.getByTestId('ledger-issue-remainder');
    const outside = (testId: string) =>
      screen.getAllByTestId(testId).filter((row) => !remainder.contains(row));
    expect(outside('ledger-issue-row')).toHaveLength(15);
    expect(outside('ledger-issue-row-compact')).toHaveLength(15);
    expect(within(remainder).getAllByTestId('ledger-issue-row')).toHaveLength(
      5,
    );
    expect(
      within(remainder).getAllByTestId('ledger-issue-row-compact'),
    ).toHaveLength(5);
    expect(screen.getAllByTestId('ledger-issue-row')).toHaveLength(20);
  });

  it('labels an estimated cost total beyond its visual tilde and leaves a fully-measured total unmarked', () => {
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

    const estimates = screen.getAllByLabelText('Estimated cost $3.50');
    expect(estimates).toHaveLength(2);
    expect(
      estimates.every((estimate) => estimate.textContent === '~$3.50est.'),
    ).toBe(true);
    expect(screen.getAllByText('$2.50')).toHaveLength(2);
  });

  it('renders the partial-cost footnote', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 'no-issue', sessions: 1, turns: 1, tokens: 100 },
      ],
      byWeek: [],
    });

    expect(screen.getByText(/bucket can still be partial/)).toBeTruthy();
  });

  it('drops Turns from the compact per-issue table, but keeps Cost (#203) and cost-weighted tokens', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 42, sessions: 2, turns: 10, tokens: 3000, costUsd: 1.5 },
      ],
      byWeek: [],
    });

    const compactRow = screen.getByTestId('ledger-issue-row-compact');
    expect(compactRow.textContent).toContain('$1.50');
    expect(compactRow.textContent).toContain('2 sessions');
    expect(compactRow.textContent).toContain('3,000 cost-weighted tokens');
    expect(compactRow.textContent).not.toContain('10 turns');
  });

  it('drops Turns from the compact per-week table, but keeps Cost and cost-weighted tokens', () => {
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
    expect(compactRow.textContent).toContain('3 sessions');
    expect(compactRow.textContent).toContain('4,000 cost-weighted tokens');
    expect(compactRow.textContent).not.toContain('12 turns');
  });

  // The two compact lists trim alike (see IssueLedgerTableCompact's doc
  // comment). They drifted for one commit when the week list gained tokens
  // and the issue list didn't; this pins them together so the next trim to
  // either one has to be a deliberate decision about both.
  it('trims both compact ledgers the same way', () => {
    renderLedger({
      byIssue: [
        { issueNumber: 42, sessions: 2, turns: 10, tokens: 3000, costUsd: 1.5 },
      ],
      byWeek: [
        {
          isoWeek: '2026-W29',
          sessions: 2,
          turns: 10,
          tokens: 3000,
          costUsd: 1.5,
        },
      ],
    });

    const issue = screen.getByTestId('ledger-issue-row-compact');
    const week = screen.getByTestId('ledger-week-row-compact');
    for (const row of [issue, week]) {
      expect(row.textContent).toContain('2 sessions · 3,000 cost-weighted');
      expect(row.textContent).toContain('$1.50');
    }
  });

  it('marks a long multi-repo identity for safe compact-row truncation', () => {
    const watchedRepos = [
      { owner: 'org-a', name: 'repo-a' },
      {
        owner: 'very-long-organization-name',
        name: 'very-long-repository-name',
      },
    ];
    (getWatchedRepos as Mock)
      .mockReturnValueOnce(watchedRepos)
      .mockReturnValueOnce(watchedRepos);

    renderLedger({
      byIssue: [
        {
          issueNumber: 42,
          repo: watchedRepos[1],
          sessions: 2,
          turns: 10,
          tokens: 3000,
          costUsd: 1.5,
        },
      ],
      byWeek: [],
    });

    const compactRow = screen.getByTestId('ledger-issue-row-compact');
    const identity = compactRow.querySelector('.costs-ledger-issue-identity');
    expect(identity?.getAttribute('title')).toBe(
      'very-long-organization-name/very-long-repository-name',
    );
    expect(
      compactRow.querySelector('.costs-ledger-mobile-row__primary'),
    ).not.toBeNull();
  });
});
