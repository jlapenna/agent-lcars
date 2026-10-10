import 'server-only';

import crypto from 'node:crypto';

import { logger } from '@agent-lcars/logging';
import {
  changeCredentialOperation,
  type CredentialMutation,
  type CredentialOperation,
  type CredentialWriteReceipt,
  decidedRun,
  isRefusal,
  type OrchestratorStore,
  reserveCredentialOperation,
  type Run,
} from '@agent-lcars/orchestrator';
import { ORPCError } from '@orpc/server';

import {
  type CodexAuthLease,
  type CodexAuthStore,
  CodexAuthStoreError,
  type CodexOwnedLease,
} from './codex-auth-store';

interface BrokerContext {
  store: OrchestratorStore;
  codexAuth: CodexAuthStore;
  now: () => Date;
}

/** Serialized by the canonical Run, including across separate server processes.
 * External IO is always outside retryable Firestore transaction callbacks. */
class ReservedCodexOperation {
  readonly id = crypto.randomUUID();
  readonly claimFingerprint: string;
  private mutationSequence = 0;
  nextMutationId(): string {
    return `${this.id}:${++this.mutationSequence}`;
  }
  constructor(
    readonly context: BrokerContext,
    readonly run: Run,
  ) {
    this.claimFingerprint = run.queue?.tokenHash ?? '';
  }

  async begin(kind: CredentialOperation['kind']): Promise<Run> {
    const outcome = await this.context.store.transactRun({
      runId: this.run.runId,
      decide: ({ task, run }) =>
        task === undefined || run === undefined
          ? { refused: true, reason: 'unknown-run' }
          : reserveCredentialOperation({
              now: this.context.now().toISOString(),
              task: task.task,
              run,
              id: this.id,
              kind,
              claimFingerprint: this.claimFingerprint,
            }),
    });
    return this.accept(outcome);
  }

  private accept(outcome: Parameters<typeof isRefusal>[0]): Run {
    if (isRefusal(outcome)) {
      if (outcome.reason === 'credential-operation-pending') {
        throw new ORPCError('CONFLICT', {
          message: 'Credential operation pending recovery',
        });
      }
      throw new ORPCError('UNAUTHORIZED', { message: 'Run claim changed' });
    }
    return decidedRun(outcome);
  }

  private async change(
    change: Parameters<typeof changeCredentialOperation>[0]['change'],
  ): Promise<Run> {
    return this.accept(
      await this.context.store.transactRun({
        runId: this.run.runId,
        decide: ({ task, run }) =>
          task === undefined || run === undefined
            ? { refused: true, reason: 'unknown-run' }
            : changeCredentialOperation({
                now: this.context.now().toISOString(),
                task: task.task,
                run,
                id: this.id,
                claimFingerprint: this.claimFingerprint,
                change,
              }),
      }),
    );
  }

  async mutate(
    mutation: CredentialMutation,
    perform: () => Promise<unknown>,
    receipt?: CredentialWriteReceipt,
  ): Promise<void> {
    await this.change({ kind: 'prepare', mutation });
    try {
      await perform();
    } catch (error) {
      // Only definitive refusals can clear a prepared action. A network failure
      // may still commit later, so its reservation stays until durable fencing.
      if (
        error instanceof CodexAuthStoreError &&
        error.kind !== 'unavailable'
      ) {
        await this.change({ kind: 'acknowledge', mutationId: mutation.id });
      }
      throw error;
    }
    await this.change({
      kind: 'acknowledge',
      mutationId: mutation.id,
      ...(receipt === undefined ? {} : { receipt }),
    });
  }

  async finish(restored = false): Promise<void> {
    await this.change({
      kind: 'finish',
      ...(restored ? { restored: true } : {}),
    });
  }

  async finishIfResolved(): Promise<void> {
    const current = await this.context.store.readRun(this.run.runId);
    if (
      current?.credentialOperation?.id === this.id &&
      current.credentialOperation.mutation === undefined
    ) {
      await this.finish();
    }
  }

  owned(
    lease: CodexAuthLease | undefined,
    repository?: string,
  ): lease is CodexOwnedLease {
    return (
      lease?.runId === this.run.runId &&
      lease.claimFingerprint === this.claimFingerprint &&
      (repository === undefined || lease.repository === repository)
    );
  }

  async release(lease: CodexOwnedLease): Promise<void> {
    const id = this.nextMutationId();
    await this.mutate(
      {
        kind: 'lease-write',
        id,
        expectedGeneration: lease.generation,
        repository: lease.repository,
        expiresAt: '1970-01-01T00:00:00.000Z',
      },
      () => this.context.codexAuth.releaseLease(lease, id),
    );
  }

  async acquire(repository: string): Promise<CodexOwnedLease> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const lease = await this.context.codexAuth.readLease();
      if (
        this.owned(lease, repository) &&
        Date.parse(lease.expiresAt) > this.context.now().getTime()
      )
        return lease;
      if (
        lease !== undefined &&
        Date.parse(lease.expiresAt) > this.context.now().getTime()
      ) {
        throw new CodexAuthStoreError(
          'conflict',
          'Codex subscription authentication is already in use',
        );
      }
      const id = this.nextMutationId();
      const expectedGeneration = lease?.generation ?? '0';
      const input = {
        runId: this.run.runId,
        repository,
        expiresAt: this.run.leaseExpiresAt,
        claimFingerprint: this.claimFingerprint,
        operationId: id,
      };
      let acquired: CodexOwnedLease | undefined;
      try {
        await this.mutate(
          {
            kind: 'lease-write',
            id,
            expectedGeneration,
            repository,
            expiresAt: input.expiresAt,
          },
          async () => {
            acquired =
              lease === undefined
                ? await this.context.codexAuth.createLease(input)
                : await this.context.codexAuth.takeLease({
                    ...input,
                    expectedGeneration,
                  });
          },
        );
      } catch (error) {
        if (error instanceof CodexAuthStoreError && error.kind === 'conflict')
          continue;
        throw error;
      }
      if (this.owned(acquired, repository) && acquired.operationId === id)
        return acquired;
      throw new CodexAuthStoreError(
        'conflict',
        'Codex subscription lease changed concurrently',
      );
    }
    throw new CodexAuthStoreError(
      'conflict',
      'Codex subscription lease changed concurrently',
    );
  }
}

function logUnresolved(runId: string): void {
  logger.error(
    'agent-lcars: credential operation for %s remains reserved pending generation fencing',
    runId,
  );
}

export async function restoreCodexCredential(
  context: BrokerContext,
  run: Run,
  repository: string,
) {
  const operation = new ReservedCodexOperation(context, run);
  await operation.begin('restore');
  let lease: CodexOwnedLease | undefined;
  try {
    lease = await operation.acquire(repository);
    const snapshot = await context.codexAuth.read();
    // Recovery may have fenced this operation while a read was in flight. Its
    // old caller then gets no credential response and cannot prepare more IO.
    await operation.finish(true);
    return {
      authBase64: snapshot.authBase64,
      generation: snapshot.generation,
      sha256: snapshot.sha256,
    };
  } catch (error) {
    if (lease !== undefined) {
      try {
        await operation.release(lease);
      } catch {
        logUnresolved(run.runId);
      }
    }
    await operation.finishIfResolved();
    throw error;
  }
}

export async function renewCodexCredentialLease(
  context: BrokerContext,
  run: Run,
  renew: () => Promise<Run>,
): Promise<Run> {
  const operation = new ReservedCodexOperation(context, run);
  await operation.begin('renew');
  try {
    const renewed = await renew();
    const lease = await context.codexAuth.readLease();
    // Bootstrap heartbeat can precede credential restore. A different owner
    // grants no authority to modify its lease; no restore has happened here.
    if (
      !operation.owned(lease) &&
      renewed.credentialRestoredClaimFingerprint !== operation.claimFingerprint
    ) {
      await operation.finish();
      return renewed;
    }
    if (!operation.owned(lease))
      throw new CodexAuthStoreError(
        'conflict',
        'Codex subscription lease is not owned by this claim',
      );
    const id = operation.nextMutationId();
    const input = {
      runId: run.runId,
      repository: lease.repository,
      expiresAt: renewed.leaseExpiresAt,
      claimFingerprint: operation.claimFingerprint,
      operationId: id,
      expectedGeneration: lease.generation,
    };
    await operation.mutate(
      {
        kind: 'lease-write',
        id,
        expectedGeneration: lease.generation,
        repository: lease.repository,
        expiresAt: renewed.leaseExpiresAt,
      },
      () => context.codexAuth.takeLease(input),
    );
    await operation.finish();
    return renewed;
  } catch (error) {
    await operation.finishIfResolved();
    throw error;
  }
}

export async function releaseCodexCredentialLease(
  context: BrokerContext,
  run: Run,
): Promise<void> {
  const operation = new ReservedCodexOperation(context, run);
  await operation.begin('cleanup');
  try {
    const lease = await context.codexAuth.readLease();
    // Historical/missing-generation ownership is readable but cannot delete
    // or expire a replacement lease. Retain its ordinary expiry backstop.
    if (operation.owned(lease)) await operation.release(lease);
    await operation.finish();
  } catch (error) {
    await operation.finishIfResolved();
    throw error;
  }
}

export async function persistCodexCredential(
  context: BrokerContext,
  run: Run,
  repository: string,
  input: {
    generation: string;
    authBase64: string;
    restoredSha256: string;
    authFailure?: string;
  },
): Promise<{ status: 'skipped-burned' | 'unchanged' | 'updated' }> {
  const operation = new ReservedCodexOperation(context, run);
  const reserved = await operation.begin('persist');
  let lease: CodexOwnedLease | undefined;
  let persisted = false;
  let result:
    { status: 'skipped-burned' | 'unchanged' | 'updated' } | undefined;
  let operationError: unknown;
  try {
    const sha256 = crypto
      .createHash('sha256')
      .update(Buffer.from(input.authBase64, 'base64'))
      .digest('hex');
    const previous = reserved.credentialWriteReceipt;
    // Exact retry of a confirmed rotation: no new-generation rewrite and no
    // requirement to reacquire a credential lease already released by it.
    if (
      input.authFailure === undefined &&
      previous?.claimFingerprint === operation.claimFingerprint &&
      previous.expectedGeneration === input.generation &&
      previous.sha256 === sha256
    ) {
      persisted = true;
      result = { status: 'updated' };
    } else {
      const currentLease = await context.codexAuth.readLease();
      if (
        !operation.owned(currentLease, repository) ||
        Date.parse(currentLease.expiresAt) <= context.now().getTime()
      ) {
        throw new CodexAuthStoreError(
          'conflict',
          'Codex subscription lease is not owned by this claim',
        );
      }
      lease = currentLease;
      if (input.authFailure !== undefined)
        result = { status: 'skipped-burned' };
      else if (sha256 === input.restoredSha256)
        result = { status: 'unchanged' };
      else {
        const id = operation.nextMutationId();
        const receipt = {
          operationId: id,
          claimFingerprint: operation.claimFingerprint,
          expectedGeneration: input.generation,
          sha256,
        };
        await operation.mutate(
          {
            kind: 'auth-write',
            id,
            expectedGeneration: input.generation,
            sha256,
          },
          () =>
            context.codexAuth.replace({
              expectedGeneration: input.generation,
              authBase64: input.authBase64,
              receipt,
            }),
          receipt,
        );
        persisted = true;
        result = { status: 'updated' };
      }
    }
  } catch (error) {
    operationError = error;
  }
  // An unresolved auth write cannot be followed by cleanup, since that would
  // let another owner rotate while the original request is still in flight.
  const current = await context.store.readRun(run.runId);
  if (
    lease !== undefined &&
    current?.credentialOperation?.id === operation.id &&
    current.credentialOperation.mutation === undefined
  ) {
    try {
      await operation.release(lease);
    } catch (error) {
      if (persisted || operationError !== undefined) logUnresolved(run.runId);
      else operationError = error;
    }
  }
  await operation.finishIfResolved();
  if (operationError !== undefined) throw operationError;
  if (result === undefined)
    throw new CodexAuthStoreError(
      'unavailable',
      'Credential operation remains unresolved',
    );
  return result;
}

/** Bounded maintenance rotation. Scheduling only chooses when to attempt a
 * durable barrier; no elapsed time authorizes removing an unresolved action. */
export async function recoverCodexCredentialOperations(
  context: BrokerContext,
): Promise<{ recovered: string[]; unresolved: string[] }> {
  const now = context.now().toISOString();
  const runs = await context.store.listCredentialOperations({ now, limit: 30 });
  const recovered: string[] = [],
    unresolved: string[] = [];
  for (const run of runs) {
    const operation = run.credentialOperation;
    if (operation === undefined) continue;
    const change = async (
      next: Parameters<typeof changeCredentialOperation>[0]['change'],
    ) =>
      context.store.transactRun({
        runId: run.runId,
        decide: ({ task, run: current }) =>
          task === undefined || current === undefined
            ? { refused: true, reason: 'unknown-run' }
            : changeCredentialOperation({
                now,
                task: task.task,
                run: current,
                id: operation.id,
                claimFingerprint: operation.claimFingerprint,
                change: next,
              }),
      });
    try {
      // Rotate this candidate before external IO so a persistent failure does
      // not monopolize the oldest bounded page on every five-minute tick.
      if (isRefusal(await change({ kind: 'retry-recovery' }))) continue;
      if (operation.mutation !== undefined) {
        const fenced = await context.codexAuth.fenceMutation({
          runId: run.runId,
          operation,
          mutation: operation.mutation,
        });
        if (
          isRefusal(
            await change({
              kind: 'acknowledge',
              mutationId: operation.mutation.id,
              ...(fenced.receipt === undefined
                ? {}
                : { receipt: fenced.receipt }),
            }),
          )
        )
          continue;
      }
      const current = await context.store.readRun(run.runId);
      if (current?.credentialOperation?.id !== operation.id) continue;
      // A completed persistence/failed first restore must not leave a ghost
      // credential lease blocking the next owner. Renewals keep their live
      // lease unless a completion has already been durably accepted.
      if (
        operation.kind === 'persist' ||
        operation.kind === 'cleanup' ||
        current.credentialPendingResult !== undefined ||
        (operation.kind === 'restore' &&
          current.credentialRestoredClaimFingerprint !==
            operation.claimFingerprint)
      ) {
        const lease = await context.codexAuth.readLease();
        if (
          lease?.runId === run.runId &&
          lease.claimFingerprint === operation.claimFingerprint &&
          Date.parse(lease.expiresAt) > context.now().getTime()
        ) {
          const id = `${operation.id}:${current.credentialOperation.mutationSequence + 1}`;
          const mutation: CredentialMutation = {
            kind: 'lease-write',
            id,
            expectedGeneration: lease.generation,
            repository: lease.repository,
            expiresAt: '1970-01-01T00:00:00.000Z',
          };
          if (isRefusal(await change({ kind: 'prepare', mutation }))) continue;
          try {
            await context.codexAuth.releaseLease(lease as CodexOwnedLease, id);
          } catch (error) {
            if (
              error instanceof CodexAuthStoreError &&
              error.kind !== 'unavailable'
            ) {
              await change({ kind: 'acknowledge', mutationId: id });
            }
            throw error;
          }
          if (isRefusal(await change({ kind: 'acknowledge', mutationId: id })))
            continue;
        }
      }
      if (!isRefusal(await change({ kind: 'finish' })))
        recovered.push(run.runId);
    } catch {
      unresolved.push(run.runId);
      logUnresolved(run.runId);
    }
  }
  return { recovered, unresolved };
}
