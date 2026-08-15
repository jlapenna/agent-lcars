import 'server-only';

import {
  type DispatchOutcomeKind,
  type DispatchOutcomeReference,
  isDispatchOutcomeKind,
  isDispatchOutcomeReference,
  isLaneReadinessFailure,
  isWellFormedRecoveryObservation,
  type LaneReadinessFailure,
  type RecoveryObservation,
  WORKER_WORKFLOW_FILES,
} from '@agent-lcars/dispatch-contracts';

import type {
  CompletionOidcIdentity,
  ReconcileOidcIdentity,
  RecoveryObservationOidcIdentity,
} from '../github-actions-oidc';

/** The verified identity available to a hosted lifecycle route. */
export type HostedAuthenticatedContext =
  | CompletionOidcIdentity
  | RecoveryObservationOidcIdentity
  | ReconcileOidcIdentity;

export type HostedCompletionAuthenticatedContext = CompletionOidcIdentity;
export type HostedRecoveryObservationAuthenticatedContext =
  RecoveryObservationOidcIdentity;
export type HostedReconcileAuthenticatedContext = ReconcileOidcIdentity;

/** The body sent by the worker completion callback. */
export interface HostedCompletionRequestBody {
  issue: number;
  generation: number;
  intentId: string;
  token: string;
  workflow: string;
  outcome?: DispatchOutcomeKind;
  outcomeReference?: DispatchOutcomeReference;
  readinessFailure?: LaneReadinessFailure;
}

/** The durable recovery fact submitted by a hosted observation caller. */
export type HostedRecoveryObservationRequestBody = RecoveryObservation;

/** Reconcile is intentionally a body-less command. */
export type HostedReconcileRequestBody = undefined;

/** A route boundary rejection that must be rendered as a 400 or 401. */
export class HostedRouteContractError extends Error {}

/**
 * Parse exactly one `Bearer <token>` Authorization value.
 *
 * Keep this deliberately byte-compatible with the three existing hosted
 * routes: the scheme is case-sensitive, exactly one ASCII space is required,
 * and the token cannot contain whitespace. A combined duplicate header (for
 * example, `Bearer one, Bearer two`) consequently fails closed.
 */
export function parseHostedBearerToken(header: string | null): string {
  const match = header?.match(/^Bearer ([^\s]+)$/u);
  if (!match) throw new HostedRouteContractError('A bearer token is required');
  return match[1];
}

/** Decode one JSON body and apply a route-specific strict parser. */
export function parseHostedJsonBody<T>(
  rawBody: string,
  parser: (value: unknown) => T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(rawBody) as unknown;
  } catch {
    throw new HostedRouteContractError('Request body is malformed JSON');
  }
  return parser(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostedRouteContractError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new HostedRouteContractError(`${name} contains an unknown field`);
  }
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HostedRouteContractError(
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

function exactOutcomeReference(value: unknown): DispatchOutcomeReference {
  const candidate = record(value, 'Completion outcomeReference');
  exactKeys(candidate, ['kind', 'number'], 'Completion outcomeReference');
  if (
    !isDispatchOutcomeReference(candidate) ||
    Object.keys(candidate).length !== 2
  ) {
    throw new HostedRouteContractError(
      'Completion outcomeReference is malformed',
    );
  }
  return candidate as DispatchOutcomeReference;
}

/** Parse and validate the strict completion callback body. */
export function parseHostedCompletionRequestBody(
  value: unknown,
): HostedCompletionRequestBody {
  const candidate = record(value, 'Completion request');
  exactKeys(
    candidate,
    [
      'issue',
      'generation',
      'intentId',
      'token',
      'workflow',
      'outcome',
      'outcomeReference',
      'readinessFailure',
    ],
    'Completion request',
  );

  const issue = positiveSafeInteger(candidate['issue'], 'Completion issue');
  const generation = positiveSafeInteger(
    candidate['generation'],
    'Completion generation',
  );
  const intentId = candidate['intentId'];
  const token = candidate['token'];
  const workflow = candidate['workflow'];
  if (
    typeof intentId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(intentId)
  ) {
    throw new HostedRouteContractError('Completion intentId is malformed');
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/u.test(token)) {
    throw new HostedRouteContractError('Completion token is malformed');
  }
  if (typeof workflow !== 'string' || !WORKER_WORKFLOW_FILES.has(workflow)) {
    throw new HostedRouteContractError('Completion workflow is not allowed');
  }

  const outcome = candidate['outcome'];
  if (outcome !== undefined && !isDispatchOutcomeKind(outcome)) {
    throw new HostedRouteContractError('Completion outcome is not allowed');
  }
  const outcomeReference = candidate['outcomeReference'];
  if (outcomeReference !== undefined) {
    if (outcome !== 'pull-request') {
      throw new HostedRouteContractError(
        'Completion outcomeReference requires a pull-request outcome',
      );
    }
    exactOutcomeReference(outcomeReference);
  }
  const readinessFailure = candidate['readinessFailure'];
  if (
    readinessFailure !== undefined &&
    !isLaneReadinessFailure(readinessFailure)
  ) {
    throw new HostedRouteContractError(
      'Completion readinessFailure is not allowed',
    );
  }

  return {
    issue,
    generation,
    intentId,
    token,
    workflow,
    ...(outcome === undefined ? {} : { outcome }),
    ...(outcomeReference === undefined
      ? {}
      : { outcomeReference: outcomeReference as DispatchOutcomeReference }),
    ...(readinessFailure === undefined ? {} : { readinessFailure }),
  };
}

function exactRecoveryObservation(value: unknown): RecoveryObservation {
  const candidate = record(value, 'Recovery observation');
  exactKeys(
    candidate,
    [
      'operationKey',
      'target',
      'sourceKind',
      'observedAt',
      'evidence',
      'detail',
    ],
    'Recovery observation',
  );
  const target = record(candidate['target'], 'Recovery observation target');
  exactKeys(
    target,
    ['domain', 'repositoryId', 'repository', 'anchor', 'exactIdentity'],
    'Recovery observation target',
  );
  if (!isWellFormedRecoveryObservation(candidate)) {
    throw new HostedRouteContractError(
      'Recovery observation is not well formed',
    );
  }
  return candidate as RecoveryObservation;
}

/** Parse and validate a strict recovery-observation body. */
export function parseHostedRecoveryObservationRequestBody(
  value: unknown,
): HostedRecoveryObservationRequestBody {
  return exactRecoveryObservation(value);
}

/**
 * Bind the only caller-supplied repository fields to verified authority.
 *
 * The body remains unchanged on success; a mismatch is rejected rather than
 * being repaired or silently rewritten. This keeps repository identity and
 * numeric repository identity in the authenticated context, never in JSON.
 */
export function assertHostedRecoveryObservationAuthority(
  body: HostedRecoveryObservationRequestBody,
  context: HostedRecoveryObservationAuthenticatedContext,
): HostedRecoveryObservationRequestBody {
  if (body.target.repository !== context.repository) {
    throw new HostedRouteContractError(
      'Recovery observation repository does not match authenticated context',
    );
  }
  if (body.target.repositoryId !== context.repositoryId) {
    throw new HostedRouteContractError(
      'Recovery observation repository ID does not match authenticated context',
    );
  }
  return body;
}

/** Reject any body on the body-less reconcile command. */
export function parseHostedReconcileRequestBody(
  value: unknown,
): HostedReconcileRequestBody {
  if (value !== undefined && value !== '') {
    throw new HostedRouteContractError(
      'Reconcile request must not have a body',
    );
  }
  return undefined;
}
