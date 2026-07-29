import { describe, expect, it } from 'vitest';

import { formatCost } from './format';

describe('formatCost', () => {
  it('formats a positive amount to two decimal places', () => {
    expect(formatCost(3.1)).toBe('$3.10');
  });

  it('formats zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('floors a negative amount at $0.00 rather than rendering a negative dollar figure', () => {
    expect(formatCost(-1.23)).toBe('$0.00');
  });

  // #213: the ledger's whole-window totals are four and five figures, and
  // the bare `toFixed(2)` this used to be rendered them as "$3953.71".
  it('groups thousands', () => {
    expect(formatCost(3953.71)).toBe('$3,953.71');
    expect(formatCost(1344.156)).toBe('$1,344.16');
    expect(formatCost(1234567.8)).toBe('$1,234,567.80');
  });
});
