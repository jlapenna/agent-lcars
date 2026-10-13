import { describe, expect, it } from 'vitest';

import { ledgerCsv } from './ledger-csv';

describe('ledgerCsv', () => {
  it('writes issue and week rows with costs and the estimate flag', () => {
    const csv = ledgerCsv({
      byIssue: [
        {
          issueNumber: 42,
          repo: { owner: 'o', name: 'r' },
          sessions: 2,
          turns: 9,
          tokens: 1500,
          costUsd: 1.5,
          costEstimated: true,
        },
        { issueNumber: 'no-issue', sessions: 1, turns: 1, tokens: 10 },
      ],
      byWeek: [
        {
          isoWeek: '2026-W42',
          sessions: 3,
          turns: 10,
          tokens: 1510,
          costUsd: 1.5,
        },
      ],
    });
    expect(csv.split('\n')).toEqual([
      'section,key,repository,sessions,turns,cost_weighted_tokens,cost_usd,cost_estimated',
      'issue,#42,o/r,2,9,1500,1.5000,yes',
      'issue,no-issue,,1,1,10,,no',
      'week,2026-W42,,3,10,1510,1.5000,no',
      '',
    ]);
  });

  it('quotes separators and neutralises spreadsheet formulas', () => {
    const csv = ledgerCsv({
      byIssue: [],
      byWeek: [
        { isoWeek: '=HYPERLINK("x"),1', sessions: 1, turns: 1, tokens: 1 },
      ],
    });
    expect(csv.split('\n')[1]).toBe(`week,"'=HYPERLINK(""x""),1",,1,1,1,,no`);
  });
});
