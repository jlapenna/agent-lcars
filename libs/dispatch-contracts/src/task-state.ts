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

export function isAuthoritativeTaskState(
  value: unknown,
): value is AuthoritativeTaskState {
  if (!isPlainObject(value)) return false;
  const task = value.task;
  const controllerState = value.controllerState;
  if (!isPlainObject(task) || !isPlainObject(controllerState)) return false;
  const generations = controllerState.generations;
  if (!Array.isArray(generations)) return false;
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
    value.schema === AUTHORITATIVE_TASK_STATE_SCHEMA &&
    Number.isSafeInteger(value.storageRevision) &&
    (value.storageRevision as number) >= 0 &&
    typeof value.updatedAt === 'string' &&
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
