import { describe, expect, it } from 'vitest';

import { isTransientFirestoreError } from './hook-store';

describe('isTransientFirestoreError', () => {
  it('retries network, contention, quota, and auth failures', () => {
    for (const code of [2, 4, 8, 10, 14, 16]) {
      expect(isTransientFirestoreError({ code })).toBe(true);
    }
    expect(isTransientFirestoreError(new Error('socket hang up'))).toBe(true);
  });

  it('drops permanent failures', () => {
    for (const code of [3, 5, 6, 7, 9, 11, 12, 13]) {
      expect(isTransientFirestoreError({ code })).toBe(false);
    }
  });
});
