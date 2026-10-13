import { repoKey } from './github-client';
import type { SessionLedger } from './session-ledger';

function cell(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  // Quote anything that could split a row or a field, and neutralise a
  // leading formula character so a spreadsheet never evaluates a cell.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The cost ledger as one CSV ("Export ledger"): the by-issue and by-week
 * tables the page shows, distinguished by a leading `section` column, with
 * the same totals and the estimated-cost caveat as a column.
 */
export function ledgerCsv(ledger: SessionLedger): string {
  const header = [
    'section',
    'key',
    'repository',
    'sessions',
    'turns',
    'cost_weighted_tokens',
    'cost_usd',
    'cost_estimated',
  ];
  const lines = [header.join(',')];
  for (const row of ledger.byIssue) {
    lines.push(
      [
        'issue',
        row.issueNumber === 'no-issue' ? 'no-issue' : `#${row.issueNumber}`,
        row.repo ? repoKey(row.repo) : undefined,
        row.sessions,
        row.turns,
        row.tokens,
        row.costUsd?.toFixed(4),
        row.costEstimated ? 'yes' : 'no',
      ]
        .map(cell)
        .join(','),
    );
  }
  for (const row of ledger.byWeek) {
    lines.push(
      [
        'week',
        row.isoWeek,
        undefined,
        row.sessions,
        row.turns,
        row.tokens,
        row.costUsd?.toFixed(4),
        row.costEstimated ? 'yes' : 'no',
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
