import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { isE2eTesting } from './env';

describe('env', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('isE2eTesting returns true when E2E_TESTING is true', () => {
    process.env['E2E_TESTING'] = 'true';
    expect(isE2eTesting()).toBe(true);
  });
});
