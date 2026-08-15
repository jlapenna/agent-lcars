import { z } from 'zod';

import { LIFECYCLE_DURABILITY_LIMITS } from './durability';

/** UTF-8 length is the durable wire-size unit, not JavaScript code units. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Bounds for mutable provider display metadata. Hashes intentionally remain
 * separate fixed-format primitives below; they are not general strings.
 */
export const DURABLE_SCALAR_BYTE_LIMITS =
  LIFECYCLE_DURABILITY_LIMITS.scalarBytes;

export function utf8ByteLimitedStringSchema(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('UTF-8 byte limit must be a finite positive integer');
  }
  return z
    .string()
    .refine(
      (value) => utf8ByteLength(value) <= maxBytes,
      `Must be at most ${maxBytes} UTF-8 bytes`,
    );
}

/** Closed, provider-neutral primitives shared by control-plane wire records. */
export const opaqueIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

/** Route-safe, server-minted 128-bit-or-stronger unpadded base64url ID. */
export const attemptIdSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_-]{22,}$/u);

export const positiveSafeIntegerSchema = z.number().int().safe().positive();
export const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .safe()
  .nonnegative();

/** RFC-3339 UTC timestamps. Offset forms are intentionally not accepted. */
export const utcDateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z'), 'Must be a UTC timestamp');

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

/** GitHub Actions currently signs workflow commits as lowercase Git SHA-1. */
export const gitCommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
