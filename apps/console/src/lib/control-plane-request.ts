import 'server-only';

import { z } from 'zod';

/**
 * A control-plane request failed to parse or was not authoritative for what
 * it claimed, before reaching any downstream domain logic. Every parser and
 * assertion in this module throws exactly this type on bad input, so a route
 * can `catch` once and answer 400 rather than 500 -- see each route's outer
 * catch block. The message is safe to log but this module never embeds the
 * raw request body or bearer token in it, and routes never echo it back to
 * the caller.
 */
export class HostedRouteRequestError extends Error {}

/**
 * Extract the token from an `Authorization: Bearer <token>` header. Throws
 * on a missing header, a non-Bearer scheme, or an empty token -- callers
 * treat any failure here as unauthenticated, not as a 400.
 */
export function parseHostedBearerToken(header: string | null): string {
  const match = header?.match(/^Bearer (\S+)$/u);
  if (!match) {
    throw new HostedRouteRequestError('Missing or malformed bearer token');
  }
  return match[1];
}

/**
 * Parse a request body as JSON, then hand the result to `parse` for shape
 * validation. Malformed JSON becomes a `HostedRouteRequestError` like any
 * other shape failure, so callers can treat "not JSON" and "wrong shape" the
 * same way.
 */
export function parseHostedJsonBody<T>(
  text: string,
  parse: (value: unknown) => T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HostedRouteRequestError('Request body is not valid JSON');
  }
  return parse(value);
}

const hostedCompletionRequestSchema = z
  .object({
    issue: z.number().int().safe().positive(),
    workflow: z.string().min(1),
    generation: z.number().int().safe().optional(),
    intentId: z.string().min(1).optional(),
    /** Echoed back from the dispatch token minted at `beginDispatch`
     *  (`crypto.randomBytes(24).toString('base64url')`, 32 characters); 16
     *  is a floor that rejects an obviously wrong value without hard-coding
     *  the exact minted length here. */
    token: z.string().min(16).optional(),
    outcome: z.unknown().optional(),
    outcomeReference: z.unknown().optional(),
    readinessFailure: z.unknown().optional(),
  })
  .strict();

/**
 * Validate a hosted worker completion callback body. This is wire-shape
 * validation only -- binding the completion to the correct ledger
 * generation happens deeper, in `assertCompletionLedgerBinding`.
 */
export function parseHostedCompletionRequestBody(
  value: unknown,
): z.infer<typeof hostedCompletionRequestSchema> {
  const result = hostedCompletionRequestSchema.safeParse(value);
  if (!result.success) {
    throw new HostedRouteRequestError('Invalid completion request body');
  }
  return result.data;
}

/**
 * The scheduled reconcile trigger carries no payload of its own -- reject
 * anything but an empty body so a caller sending unexpected data fails fast
 * instead of having it silently ignored.
 */
export function parseHostedReconcileRequestBody(text: string): void {
  if (text.trim().length > 0) {
    throw new HostedRouteRequestError('Reconcile request must have no body');
  }
}
