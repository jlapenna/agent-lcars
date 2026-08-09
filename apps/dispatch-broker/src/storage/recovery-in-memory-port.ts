/**
 * In-memory reference implementation of `RecoveryOperationPort`, mirroring
 * `./in-memory-port.ts`'s role for `StoragePort`: its job is to make
 * `./recovery-port.contract.ts`'s suite pass, proving the contract is
 * satisfiable, and to give tests a real port without standing up
 * infrastructure. Not durable, not wired into any live path.
 */

import type { RecoveryObservation } from '@agent-lcars/dispatch-contracts';

import {
  type RecordedRecoveryOperation,
  RecoveryOperationAlreadyResolvedError,
  RecoveryOperationNotRecordedError,
  type RecoveryOperationPort,
  type RecoveryOperationStatus,
} from './recovery-port';

function defaultNow(): string {
  return new Date().toISOString();
}

export class InMemoryRecoveryOperationPort implements RecoveryOperationPort {
  #operations = new Map<string, RecordedRecoveryOperation>();

  async recordObservation(
    observation: RecoveryObservation,
    now: string = defaultNow(),
  ): Promise<RecordedRecoveryOperation> {
    const existing = this.#operations.get(observation.operationKey);
    if (existing) {
      // First-observation-wins: a later observation of the same fact is
      // evidence the fact still holds, not a reason to replace who
      // recorded it first or touch its resolution.
      return structuredClone(existing);
    }
    const created: RecordedRecoveryOperation = {
      operationKey: observation.operationKey,
      observation: structuredClone(observation),
      recordedAt: now,
      status: 'pending',
    };
    this.#operations.set(observation.operationKey, created);
    return structuredClone(created);
  }

  async resolveRecoveryOperation(
    operationKey: string,
    status: Exclude<RecoveryOperationStatus, 'pending'>,
    detail?: string,
    now: string = defaultNow(),
  ): Promise<RecordedRecoveryOperation> {
    const existing = this.#operations.get(operationKey);
    if (!existing) {
      throw new RecoveryOperationNotRecordedError(operationKey);
    }
    if (existing.status !== 'pending') {
      const sameResolution =
        existing.status === status && existing.detail === detail;
      if (sameResolution) {
        return structuredClone(existing);
      }
      throw new RecoveryOperationAlreadyResolvedError(
        operationKey,
        existing.status,
      );
    }
    const resolved: RecordedRecoveryOperation = {
      ...existing,
      status,
      resolvedAt: now,
      ...(detail === undefined ? {} : { detail }),
    };
    this.#operations.set(operationKey, resolved);
    return structuredClone(resolved);
  }

  async readRecoveryOperation(
    operationKey: string,
  ): Promise<RecordedRecoveryOperation | undefined> {
    const stored = this.#operations.get(operationKey);
    return stored ? structuredClone(stored) : undefined;
  }

  async listPendingRecoveryOperations(): Promise<RecordedRecoveryOperation[]> {
    return [...this.#operations.values()]
      .filter((operation) => operation.status === 'pending')
      .map((operation) => structuredClone(operation));
  }
}
