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
});
