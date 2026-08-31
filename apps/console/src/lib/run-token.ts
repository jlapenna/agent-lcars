import 'server-only';

import crypto from 'node:crypto';

/** 256-bit random, base64url -- returned exactly once, from `claim`.
 * Sized to 32 bytes because this token is the sole credential for the
 * executor's run routes, rather than an echoed-back replay guard. */
export function mintRunToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** `sha256(token)`, hex -- the only form ever persisted (`Run.queue.
 *  tokenHash`). Callers compare with `runTokenMatches`, never with `===`. */
export function hashRunToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of a bearer token against a stored hash.
 *  `timingSafeEqual` throws on mismatched lengths rather than returning
 *  false, so an attacker-controlled bearer of the wrong length is handled
 *  explicitly first. */
export function runTokenMatches(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashRunToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return (
    candidate.length === stored.length &&
    crypto.timingSafeEqual(candidate, stored)
  );
}
