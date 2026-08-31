import 'server-only';

/** A body or authorization header is invalid for the scheduler-only
 * reconcile endpoint. The route intentionally turns this into a generic
 * 400/401 response without exposing request content. */
export class HostedReconcileRequestError extends Error {}

/** Extract the scheduler's bearer token. Authentication failures are 401,
 * not malformed-body errors. */
export function parseReconcileBearerToken(header: string | null): string {
  const match = header?.match(/^Bearer (\S+)$/u);
  if (!match) {
    throw new HostedReconcileRequestError('Missing or malformed bearer token');
  }
  return match[1];
}

/** The scheduled reconcile trigger has no request payload. */
export function assertEmptyReconcileBody(text: string): void {
  if (text.trim().length > 0) {
    throw new HostedReconcileRequestError(
      'Reconcile request must have no body',
    );
  }
}
