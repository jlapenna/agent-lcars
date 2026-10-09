import { expect, it, vi } from 'vitest';

import { createProbeBudget } from '../probes/probe-budget.mjs';

// Regression: the native exhaustion fixture resumed after its timer returned
// while Date.now still reported time left. Its shared clock must be elapsed
// time, with wall readings used only for retained diagnostic timestamps.
it('retains one elapsed budget across backward and forward wall-clock steps', () => {
  let monotonic = 100;
  const wall = vi.spyOn(Date, 'now').mockReturnValue(100000);
  try {
    const budget = createProbeBudget(10000, () => monotonic);
    expect(budget.remainingMs()).toBe(10000);
    monotonic += 2500;
    wall.mockReturnValue(90000);
    expect(budget.remainingMs()).toBe(7500);
    monotonic += 2500;
    wall.mockReturnValue(150000);
    expect(budget.remainingMs()).toBe(5000);
    monotonic += 5000;
    wall.mockReturnValue(80000);
    expect({
      remaining: budget.remainingMs(),
      expired: budget.expired(),
    }).toEqual({ remaining: 0, expired: true });
    monotonic += 1000;
    wall.mockReturnValue(0);
    expect({
      remaining: budget.remainingMs(),
      expired: budget.expired(),
    }).toEqual({ remaining: 0, expired: true });
  } finally {
    wall.mockRestore();
  }
});

it('gives native process APIs an integer timeout without extending the budget', () => {
  let monotonic = 10;
  const budget = createProbeBudget(1000, () => monotonic);
  monotonic = 10.75;
  expect(budget.remainingMs()).toBe(999);
  monotonic = 1009.75;
  expect({
    remaining: budget.remainingMs(),
    expired: budget.expired(),
  }).toEqual({ remaining: 0, expired: true });
});
