import { describe, expect, it } from 'vitest';

import { encodeOutcomeCursor, parseOutcomeCursor } from './outcome-cursor';

describe('outcome cursor', () => {
  it('round-trips a run id with URL-significant characters', () => {
    const cursor = {
      updatedAt: '2026-08-28T10:00:00.000Z',
      runId: 'octo/example#42/r3',
    };
    const encoded = encodeOutcomeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseOutcomeCursor(encoded)).toEqual(cursor);
  });

  it('reads malformed values as the newest page', () => {
    for (const value of [
      undefined,
      ['a', 'b'],
      'not base64 json',
      Buffer.from('{"u":1}').toString('base64url'),
      Buffer.from('["not-a-time","r"]').toString('base64url'),
      Buffer.from('["2026-08-28T10:00:00.000Z",""]').toString('base64url'),
    ])
      expect(parseOutcomeCursor(value)).toBeUndefined();
  });
});
