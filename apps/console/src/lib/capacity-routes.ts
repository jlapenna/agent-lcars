import 'server-only';

import { createHash } from 'node:crypto';

import {
  type CapacityAuthority,
  CapacityProtocol,
  type CapacityReceipt,
  capacityReceiptSchema,
  CapacityRefusal,
} from '@agent-lcars/orchestrator';
import { capacityCommandSchema } from '@agent-lcars/work';
import { ORPCError } from '@orpc/server';
import type { z } from 'zod';

import {
  recordCapacityRefusal,
  recordCapacityTransition,
} from './capacity-metrics';
import type { WorkPrincipal } from './work-auth';

export function capacityAuthority(
  principal: WorkPrincipal | undefined,
): CapacityAuthority {
  if (principal?.capacityPool === undefined)
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Capacity pool grant required',
    });
  const capabilities: CapacityAuthority['capabilities'] = new Set([
    ...(principal.scopes.has('work.executor') ? ['claim' as const] : []),
    ...(principal.scopes.has('work.capacity.recover')
      ? ['recover' as const]
      : []),
    ...(principal.scopes.has('work.capacity.fence') ? ['fence' as const] : []),
    ...(principal.scopes.has('work.capacity.operator')
      ? ['operator' as const]
      : []),
  ]);
  return {
    poolId: principal.capacityPool,
    subject: principal.subject.toLowerCase(),
    pipelines: principal.pipelines,
    capabilities,
  };
}
export const receiptFence = (receipt: CapacityReceipt) => ({
  poolId: receipt.poolId,
  slot: receipt.slot,
  revision: receipt.revision,
  runId: receipt.runId,
  nonce: receipt.nonce,
});

export async function capacityCall<T>(
  call: () => Promise<T>,
  action = 'validation',
): Promise<T> {
  try {
    const result = await call();
    recordCapacityTransition(action);
    return result;
  } catch (error) {
    if (error instanceof CapacityRefusal) recordCapacityRefusal(error.reason);
    if (error instanceof CapacityRefusal)
      throw new ORPCError(
        error.reason === 'authority' ? 'UNAUTHORIZED' : 'CONFLICT',
        { message: error.message },
      );
    throw error;
  }
}

export async function applyCapacityCommand(
  protocol: CapacityProtocol,
  authority: CapacityAuthority,
  input: z.infer<typeof capacityCommandSchema>,
  now: string,
) {
  const receiptResult = async (promise: Promise<CapacityReceipt>) => {
    const receipt = await promise;
    return {
      ok: true,
      receipt: receiptFence(receipt),
      jobName: receipt.jobName,
    };
  };
  switch (input.action) {
    case 'inspect-retired':
      return {
        ok: true,
        retirement: await protocol.inspectRetired(authority, input.runId, now),
      };
    case 'register':
      await protocol.register(authority, input.producerId, now);
      return { ok: true };
    case 'configure':
      await protocol.configure(authority, input.policy, now);
      return { ok: true };
    case 'recover':
      return receiptResult(
        protocol.recover(authority, input.fence, {
          nonce: input.recoveryNonce,
          purpose: input.purpose,
          now,
          expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
        }),
      );
    case 'authorize-producer':
      return receiptResult(
        protocol.authorizeProducer(authority, input.fence, {
          ...input,
          now,
        }),
      );
    case 'bind':
      return receiptResult(
        protocol.bind(authority, input.fence, { ...input, now }),
      );
    case 'attest':
      return receiptResult(
        protocol.attest(authority, input.fence, { ...input, now }),
      );
    case 'worker-retired':
      return receiptResult(
        protocol.workerRetired(authority, input.fence, {
          ...input,
          now,
        }),
      );
    case 'operation':
      return receiptResult(
        protocol.operation(authority, input.fence, {
          ...input,
          now,
        }),
      );
    case 'stop-producer':
      await protocol.stopProducer(authority, input.fence, { ...input, now });
      return { ok: true };
    case 'retire':
      return receiptResult(
        protocol.retire(authority, input.fence, { ...input, now }),
      );
    case 'release':
      return {
        ok: true,
        ...(await protocol.release(authority, input.fence, {
          ...input,
          now,
        })),
      };
    case 'resolve-retired-write':
      return {
        ok: true,
        ...(await protocol.retiredWriteResolved(authority, { ...input, now })),
      };
    case 'import': {
      // The owning transaction rechecks every hash/run mapping and the review
      // digest. These point reads prepare the proposal, never authorize import.
      const state = await protocol.read(now);
      const policy = state.policies.find(
        (value) => value.poolId === authority.poolId,
      );
      if (policy === undefined) throw new CapacityRefusal('policy');
      const receipts = await Promise.all(
        input.inventory.map(async (item) => {
          const run = await protocol.store.readRun(item.runId);
          const domain = policy.domains[item.pipeline];
          if (domain === undefined) throw new CapacityRefusal('policy');
          return capacityReceiptSchema.parse({
            poolId: authority.poolId,
            slot: item.slot,
            revision: item.revision,
            runId: item.runId,
            nonce: item.nonce,
            domainId: domain.domainId,
            pipeline: item.pipeline,
            subject: item.producerSubject,
            runner: item.runner,
            producerId: item.producerId,
            claimedAt: run?.queue?.claimedAt ?? item.observedAt,
            state: 'quarantined',
            unplaced: item.unplaced,
            tokenHash: run?.queue?.tokenHash ?? '0'.repeat(64),
            jobUid: item.jobUid,
            secretUid: item.secretUid,
            jobName: `lcars-work-${createHash('sha256').update(item.runId).digest('hex').slice(0, 40)}`,
            producers: [
              {
                producerId: item.producerId,
                subject: item.producerSubject,
                stopped: false,
                fenced: false,
                pendingWrites: item.pendingWrites,
              },
            ],
          });
        }),
      );
      return {
        ok: true,
        ...(await protocol.importInventory(authority, {
          now,
          dryRun: input.dryRun,
          reviewedDigest: input.reviewedDigest,
          known: input.known,
          evidence: input.evidence,
          receipts,
        })),
      };
    }
  }
}
