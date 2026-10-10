import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatCompactRelativeTime,
  formatCost,
  formatRelativeTime,
} from './format';

describe('relative deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T07:44:39.955Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the observed queued lease deadline as future time', () => {
    const leaseExpiresAt = '2026-10-10T09:32:27.791Z';
    expect(formatRelativeTime(leaseExpiresAt)).toBe('in 1 hour');
    expect(formatCompactRelativeTime(leaseExpiresAt)).toBe('in 1h');
  });

  it.each([
    [0.1, 'in 1 second', 'in 1s'],
    [30, 'in 30 seconds', 'in 30s'],
    [60, 'in 1 minute', 'in 1m'],
    [3600, 'in 1 hour', 'in 1h'],
    [86400, 'tomorrow', 'in 1d'],
    [0, 'just now', 'now'],
    [-30, 'just now', 'now'],
    [-60, '1 minute ago', '1m ago'],
    [-3600, '1 hour ago', '1h ago'],
    [-86400, 'yesterday', '1d ago'],
  ])('formats a timestamp %i seconds from now', (offset, full, compact) => {
    const iso = new Date(Date.now() + offset * 1000).toISOString();
    expect(formatRelativeTime(iso)).toBe(full);
    expect(formatCompactRelativeTime(iso)).toBe(compact);
  });
});

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
