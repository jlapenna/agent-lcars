import 'server-only';

import crypto from 'node:crypto';

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

/**
 * #1215: the internal-workflow request body -- an OIDC-authenticated
 * caller's ask to work an issue, carrying the `runbook`/`context` dispatch
 * parameters the label-admission webhook has no way to express (a GitHub
 * label is just a name). Every field is bounded well inside
 * `@agent-lcars/orchestrator`'s own `Run.params` limits (record values
 * max 8,192 chars -- see `libs/orchestrator/src/model.ts`'s `runSchema`) so
 * a caller who sends something too large gets a 400 here rather than an
 * unhandled internal error deeper in the orchestrator.
 */
const hostedDispatchRequestSchema = z
  .object({
    issue: z.number().int().safe().positive(),
    pipeline: z.enum(['claude', 'codex', 'opencode']),
    mode: z.string().min(1).max(64).optional(),
    reply: z.string().max(8_192).optional(),
    runbook: z.string().min(1).max(128).optional(),
    context: z.string().max(4_096).optional(),
    /** Caller-supplied idempotency key; defaults via
     *  {@link defaultDispatchRequestId} when absent. */
    requestId: z.string().min(1).max(128).optional(),
  })
  // #1633 owns migration of this residual workflow endpoint to the
  // contract-first Work API after its external consumers move.
  .strict();

/**
 * Validate an authenticated dispatch request body. This is wire-shape
 * validation only -- the caller's identity (which repository, which run) is
 * established separately by `verifyRequestOidcToken` before this is ever
 * called.
 */
export function parseHostedDispatchRequestBody(
  value: unknown,
): z.infer<typeof hostedDispatchRequestSchema> {
  const result = hostedDispatchRequestSchema.safeParse(value);
  if (!result.success) {
    throw new HostedRouteRequestError('Invalid dispatch request body');
  }
  return result.data;
}

/**
 * Default idempotency key for a dispatch request that doesn't supply its
 * own `requestId`. GitHub Actions' own delivery semantics are
 * at-least-once, not exactly-once -- a step retry, a rerun of a failed job,
 * or a scheduler tick landing twice all mean a caller may ask for the same
 * work more than once with no way for it to remember a prior `requestId`.
 * Digesting `(repository, issue, runbook, caller run id)` maps a retry of
 * the SAME workflow run back onto the SAME orchestrator request, which
 * `Orchestrator.request` already treats as idempotent ("duplicate-request")
 * -- this is not a new mechanism, just a deterministic way to reach it
 * without the caller having to invent and remember its own key.
 *
 * `runbook` is included (not just `issue`) because two different runbook
 * dispatches against the same issue from the same run are legitimately
 * different requests, not duplicates of each other. The caller's own
 * `run_id` OIDC claim scopes the digest to one workflow run: retrying a
 * step within that run collapses onto one request, but an entirely new
 * workflow run (the next scheduled tick, a fresh push) mints a fresh
 * digest and therefore a fresh request, which is the right behavior for a
 * recurring caller like a schedule -- it should be able to ask again next
 * time, not have every future tick silently collapse onto the first one
 * forever. A caller that wants cross-run collapsing instead should pass an
 * explicit `requestId`.
 */
export function defaultDispatchRequestId(input: {
  repository: string;
  issue: number;
  runbook?: string;
  callerRunId?: number;
}): string {
  const digest = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        input.repository,
        input.issue,
        input.runbook ?? '',
        input.callerRunId ?? '',
      ]),
    )
    .digest('hex');
  return `request:${digest}`;
}
