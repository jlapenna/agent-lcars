import { describe, expect, it } from 'vitest';

import { ulid } from './ulid';

const WORK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

describe('ulid', () => {
  it('is 26 Crockford base32 characters', () => {
    expect(ulid()).toMatch(WORK_ID_RE);
  });

  it('encodes the time prefix monotonically for later timestamps', () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_000_000 + 60_000);
    expect(later.slice(0, 10) > earlier.slice(0, 10)).toBe(true);
  });

  it('does not repeat across many calls', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(seen.size).toBe(1000);
  });
});
