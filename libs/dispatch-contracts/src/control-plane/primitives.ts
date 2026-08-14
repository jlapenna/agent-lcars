import { z } from 'zod';

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
