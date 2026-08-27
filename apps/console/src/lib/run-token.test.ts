import { describe, expect, it } from 'vitest';

import { hashRunToken, mintRunToken, runTokenMatches } from './run-token';

describe('run-token', () => {
  it('mints a 256-bit base64url token', () => {
    const token = mintRunToken();
    expect(token).toMatch(/^[\w-]{43}$/u); // 32 bytes, base64url, no padding
  });

  it('does not repeat across many calls', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintRunToken()));
    expect(seen.size).toBe(500);
  });

  it('hashes deterministically to a 64-char hex sha256', () => {
    const token = mintRunToken();
    const hash = hashRunToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashRunToken(token)).toBe(hash);
  });

  it('different tokens hash differently', () => {
    expect(hashRunToken(mintRunToken())).not.toBe(hashRunToken(mintRunToken()));
  });

  describe('runTokenMatches', () => {
    it('is true for the token that produced the stored hash', () => {
      const token = mintRunToken();
      expect(runTokenMatches(token, hashRunToken(token))).toBe(true);
    });

    it('is false for a different token', () => {
      const token = mintRunToken();
      const other = mintRunToken();
      expect(runTokenMatches(other, hashRunToken(token))).toBe(false);
    });

    it('is false rather than throwing when the stored hash is malformed (mismatched length)', () => {
      const token = mintRunToken();
      expect(runTokenMatches(token, 'not-a-hash')).toBe(false);
    });
  });
});
