import { type Decision, type Refusal, refused, reportResult } from './decide';
import {
  type CredentialMutation,
  type CredentialOperation,
  type CredentialWriteReceipt,
  isLive,
  type Run,
  runRecoveryDeadline,
  type Task,
} from './model';

/** This schedules reconciliation, never grants timeout-based unlock. */
export const CREDENTIAL_RECOVERY_DELAY_MS = 5 * 60_000;
export function credentialRecoverAfter(now: string): string {
  return new Date(Date.parse(now) + CREDENTIAL_RECOVERY_DELAY_MS).toISOString();
}

export function reserveCredentialOperation(input: {
  now: string;
  task: Task;
  run: Run;
  claimFingerprint: string;
  id: string;
  kind: CredentialOperation['kind'];
}): Decision | Refusal {
  const { run, task, now } = input;
  if (
    run.pipeline !== 'codex' ||
    run.queue?.state !== 'claimed' ||
    run.queue.tokenHash !== input.claimFingerprint
  )
    return refused('not-claimant');
  if (run.credentialOperation !== undefined)
    return refused('credential-operation-pending');
  if (input.kind !== 'cleanup') {
    if (!isLive(run.state)) return refused('run-not-live');
    if (
      task.activeRunId !== run.runId ||
      Date.parse(runRecoveryDeadline(run) ?? run.leaseExpiresAt) <=
        Date.parse(now)
    ) {
      return refused('stale-lease');
    }
  }
  return {
    task,
    run: {
      ...run,
      credentialOperation: {
        id: input.id,
        kind: input.kind,
        claimFingerprint: input.claimFingerprint,
        startedAt: now,
        mutationSequence: 0,
        recoverAfter: credentialRecoverAfter(now),
      },
      updatedAt: now,
    },
    outbox: [],
  };
}

/** Only this exact reserved operation can prepare/acknowledge its CAS. A
 * recovered caller cannot continue IO after its reservation is removed. */
export function changeCredentialOperation(input: {
  now: string;
  task: Task;
  run: Run;
  id: string;
  claimFingerprint: string;
  change:
    | { kind: 'prepare'; mutation: CredentialMutation }
    | {
        kind: 'acknowledge';
        mutationId: string;
        receipt?: CredentialWriteReceipt;
      }
    | { kind: 'retry-recovery' }
    | {
        kind: 'finish';
        restored?: boolean;
        /** Server proof of lease retirement/absence at this exact IO sequence. */
        leaseRetiredAtSequence?: number;
      };
}): Decision | Refusal {
  const { run, task, now, change } = input;
  const op = run.credentialOperation;
  if (
    op?.id !== input.id ||
    op.claimFingerprint !== input.claimFingerprint ||
    run.queue?.state !== 'claimed' ||
    run.queue.tokenHash !== input.claimFingerprint
  ) {
    return refused('not-claimant');
  }
  if (
    change.kind === 'prepare' &&
    (change.mutation.id !== `${op.id}:${op.mutationSequence + 1}` ||
      op.mutationSequence >= 100)
  )
    return refused('not-claimant');
  if (change.kind === 'prepare' && op.mutation !== undefined)
    return refused('credential-operation-pending');
  if (change.kind === 'acknowledge' && op.mutation?.id !== change.mutationId)
    return refused('not-claimant');
  if (change.kind === 'finish' && op.mutation !== undefined)
    return refused('credential-operation-pending');
  // A completion may arrive after an external cleanup decision. Its atomic
  // settlement must observe a positive lease resolution for this same IO
  // sequence; any later prepare invalidates an earlier read/CAS proof.
  if (
    change.kind === 'finish' &&
    run.credentialPendingResult !== undefined &&
    change.leaseRetiredAtSequence !== op.mutationSequence
  )
    return refused('credential-operation-pending');
  const { credentialOperation: _previous, ...withoutOperation } = run;
  const { mutation: _mutation, ...withoutMutation } = op;
  const next: Run =
    change.kind === 'finish'
      ? withoutOperation
      : {
          ...run,
          credentialOperation:
            change.kind === 'prepare'
              ? {
                  ...op,
                  mutation: change.mutation,
                  mutationSequence: op.mutationSequence + 1,
                }
              : change.kind === 'acknowledge'
                ? withoutMutation
                : { ...op, recoverAfter: credentialRecoverAfter(now) },
        };
  if (change.kind === 'acknowledge' && change.receipt !== undefined)
    next.credentialWriteReceipt = change.receipt;
  if (change.kind === 'finish' && change.restored === true)
    next.credentialRestoredClaimFingerprint = input.claimFingerprint;
  if (change.kind === 'finish' && next.credentialPendingResult !== undefined) {
    return reportResult({
      now,
      task,
      run: next,
      claimFingerprint: next.credentialPendingResult.claimFingerprint,
      result: next.credentialPendingResult.result,
    });
  }
  return { task, run: { ...next, updatedAt: now }, outbox: [] };
}
