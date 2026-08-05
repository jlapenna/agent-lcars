import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRandomId } from './random-id';

describe('createRandomId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return bytes;
      },
    });

    expect(createRandomId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('falls back when randomUUID throws in an insecure context', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new TypeError('Secure context required');
      },
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(255);
        return bytes;
      },
    });

    expect(createRandomId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
});
