import { z } from 'zod';

import type { DispatchLedger, LedgerGeneration, LedgerTaskRef } from './ledger';
import { isPlainObject, isWellFormedLedger } from './ledger';

export const AUTHORITATIVE_TASK_STATE_SCHEMA =
  'agent-lcars.authoritative-task-state/v1' as const;

export interface AuthoritativeTaskState {
  schema: typeof AUTHORITATIVE_TASK_STATE_SCHEMA;
  task: LedgerTaskRef;
  storageRevision: number;
  updatedAt: string;
  controllerState: DispatchLedger;
}

// Envelope shape only (#884: zod); the ledger payload and the cross-field
// task-identity equality are checked below — redaction and equality are
// policy, not shape, so they stay explicit.
const taskStateEnvelopeSchema = z.looseObject({
  schema: z.literal(AUTHORITATIVE_TASK_STATE_SCHEMA),
  storageRevision: z.number().int().safe().nonnegative(),
  updatedAt: z.string(),
  task: z.looseObject({}),
  controllerState: z.looseObject({ generations: z.array(z.unknown()) }),
});

export function isAuthoritativeTaskState(
  value: unknown,
): value is AuthoritativeTaskState {
  if (!taskStateEnvelopeSchema.safeParse(value).success) return false;
  const envelope = value as Record<string, unknown>;
  const task = envelope.task as Record<string, unknown>;
  const controllerState = envelope.controllerState as Record<string, unknown>;
  const generations = controllerState.generations as unknown[];
  // The canonical ledger validator requires the private attempt token. The
  // read contract deliberately redacts it, so validate an ephemeral copy
  // with a well-formed placeholder rather than weakening ledger validation.
  const validationLedger = {
    ...controllerState,
    generations: generations.map((generation) =>
      isPlainObject(generation) && isPlainObject(generation.attempt)
        ? {
            ...generation,
            attempt: { ...generation.attempt, token: 'redacted-for-read' },
          }
        : generation,
    ),
  };
  return (
    isWellFormedLedger(validationLedger) &&
    task.repositoryId === validationLedger.task.repositoryId &&
    task.repository === validationLedger.task.repository &&
    task.issue === validationLedger.task.issue
  );
}

/** Strip the attempt capability while retaining lifecycle correlation data. */
export function redactAuthoritativeTaskState(
  state: AuthoritativeTaskState,
): AuthoritativeTaskState {
  return {
    ...state,
    controllerState: {
      ...state.controllerState,
      generations: state.controllerState.generations.map(
        (generation): LedgerGeneration => ({
          ...generation,
          attempt: generation.attempt
            ? { ...generation.attempt, token: undefined }
            : undefined,
        }),
      ),
    },
  };
}
