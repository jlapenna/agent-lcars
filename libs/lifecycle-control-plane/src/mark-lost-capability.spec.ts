import {
  type AcceptedAttemptSpec,
  appendAttemptHistoryTransition,
  attemptHistoryRecordReference,
  attemptHistoryTransitionDigest,
  attemptSpecDigest,
  canonicalDurableJson,
  createGenesisAttemptHistoryHead,
  type RunBinding,
  runtimeObservationPayloadSha256,
  sha256Digest,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import {
  isVerifiedMarkLostTermination,
  MarkLostBoundary,
  markLostEventId,
  markLostLeaseFence,
  type MarkLostLeaseIdentity,
} from './mark-lost-capability';
import {
  hasMarkLostEligibilityFence,
  isMarkLostEligibilityReceipt,
  RunStuckObservationBoundary,
  validateMarkLostEligibility,
} from './mark-lost-eligibility';

// ---- fixture helpers, copied/trimmed from mark-lost-eligibility.spec.ts ----
// They build a fully valid eligibility request/receipt so this spec exercises
// real, boundary-minted receipts rather than hand-rolled stand-ins.

const attemptId = 'A'.repeat(22);
const sha = 'a'.repeat(64);
const workflowSha = 'b'.repeat(40);
const baselineAt = '2026-08-15T00:00:00.000Z';
const graceAt = '2026-08-15T04:00:00.000Z';
const secondAt = '2026-08-15T04:30:00.000Z';
const thirdAt = '2026-08-15T05:00:00.000Z';

const binding: RunBinding = {
  runId: 10,
  runAttempt: 1,
  checkRunId: 11,
  workflowPath: '.github/workflows/worker.yml',
  workflowRef: 'refs/heads/main',
  workflowSha,
};

const spec: AcceptedAttemptSpec = {
  schema: 'agent-lcars.attempt-spec/v1',
  version: 1,
  requestId: 'request-1',
  attemptId,
  tenant: {
    tenantId: 'tenant-1',
    repositoryId: 123,
    repository: 'octo/example',
    installationId: 456,
  },
  task: { tenantId: 'tenant-1', repositoryId: 123, issueNumber: 7 },
  activation: {
    activationId: 'activation-1',
    taskClassId: 'github-issue',
    authorityEpoch: 4,
    mode: 'central-authoritative',
  },
  local: {
    intentId: 'intent-1',
    generation: 1,
    attemptMarker: 'g1:intent-1',
    admissionRevision: 1,
    idempotencyKey: 'admission-1',
  },
  execution: {
    workflowPath: binding.workflowPath,
    workflowRef: binding.workflowRef,
    workflowSha,
    mode: 'implement',
    executorId: 'executor-1',
    credentialProfileId: 'profile-1',
    renewalDeadline: '2026-08-16T00:00:00.000Z',
  },
  authorization: {
    schema: 'agent-lcars.policy-decision/v1',
    version: 1,
    policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: sha },
    decision: 'accepted',
    ruleId: 'rule-1',
    sourceFactId: 'source-1',
    principal: { kind: 'system', systemId: 'scheduler-1' },
    evidenceRef: 'evidence-1',
    decidedAt: baselineAt,
  },
};

async function activeAttempt() {
  const initial = createGenesisAttemptHistoryHead({
    tenantId: spec.tenant.tenantId,
    attemptId,
    spec,
    specDigest: attemptSpecDigest(spec),
    updatedAt: baselineAt,
  });
  const accepted = appendAttemptHistoryTransition({
    head: initial,
    nextRevision: 1,
    transitionedAt: baselineAt,
    emitted: [
      {
        stream: 'command',
        payload: {
          schema: 'agent-lcars.attempt-command/v1',
          version: 1,
          transitionedAt: baselineAt,
          canonicalDigest: attemptHistoryTransitionDigest({
            kind: 'launch-accepted',
            eventId: 'launch-accepted-1',
          }),
          payload: { kind: 'launch-accepted', commandId: 'launch-accepted-1' },
        },
      },
    ],
  });
  const payload = { kind: 'run-bound' as const, binding };
  const payloadSha256 = await runtimeObservationPayloadSha256(payload);
  const envelope = {
    schema: 'agent-lcars.runtime-observation/v1' as const,
    version: 1 as const,
    requestId: 'bound-request-1',
    factId: 'bound-fact-1',
    attemptId,
    tenant: spec.tenant,
    task: spec.task,
    source: { kind: 'github-provider' as const, sourceId: 'github-1' },
    observedAt: baselineAt,
    payloadSha256,
    payload,
  };
  const boundPayload = {
    schema: 'agent-lcars.attempt-fact/v1' as const,
    version: 1 as const,
    factId: envelope.factId,
    requestId: envelope.requestId,
    source: envelope.source,
    observedAt: baselineAt,
    transitionedAt: baselineAt,
    payloadSha256,
    canonicalDigest: attemptHistoryTransitionDigest({
      kind: 'observation',
      envelope,
    }),
    payload,
  };
  const bound = appendAttemptHistoryTransition({
    head: accepted.head,
    nextRevision: 2,
    transitionedAt: baselineAt,
    emitted: [{ stream: 'fact', payload: boundPayload }],
  });
  const record = bound.records[0];
  const reference = attemptHistoryRecordReference(
    record,
    { tenantId: spec.tenant.tenantId, attemptId },
    'fact',
  );
  return { head: bound.head, record, payload: boundPayload, reference };
}

function observation(input: {
  readonly number: number;
  readonly observedAt: string;
  readonly status?: 'nonterminal' | 'terminal' | 'no-run' | 'contradiction';
  readonly changedBinding?: RunBinding;
  readonly proofSalt?: string;
}) {
  const status =
    input.status === 'terminal'
      ? { kind: 'terminal' as const, conclusion: 'failure' as const }
      : ({ kind: input.status ?? 'nonterminal' } as
          | { kind: 'nonterminal' }
          | { kind: 'no-run' }
          | { kind: 'contradiction' });
  const unsigned = {
    schema: 'agent-lcars.run-stuck-observation/v1' as const,
    version: 1 as const,
    factId: `stuck-fact-${input.number}`,
    requestId: `stuck-request-${input.number}`,
    source: {
      kind: 'control-plane-reconciler' as const,
      sourceId: 'reconciler-1',
    },
    binding: input.changedBinding ?? binding,
    status,
    observedAt: input.observedAt,
    proofDigest: sha256Digest(`proof-${input.number}-${input.proofSalt ?? ''}`),
  };
  const payloadDigest = sha256Digest(
    `agent-lcars.mark-lost-observation-payload/v1\u0000${canonicalDurableJson(unsigned)}`,
  );
  const canonicalDigest = sha256Digest(
    `agent-lcars.mark-lost-observation/v1\u0000${canonicalDurableJson({ ...unsigned, payloadDigest })}`,
  );
  return new RunStuckObservationBoundary({
    verifyRunStuck: () => ({ ...unsigned, payloadDigest, canonicalDigest }),
  }).verify({ candidate: undefined });
}

async function input(overrides: Record<string, unknown> = {}) {
  const attempt = await activeAttempt();
  return {
    schema: 'agent-lcars.mark-lost-eligibility-request/v1' as const,
    version: 1 as const,
    receiptId: 'receipt-1',
    idempotencyKey: 'mark-lost-key-1',
    authority: {
      authorityEpoch: 4,
      attemptRevision: 2,
      launchOperationId: attemptId,
      executionEpoch: 1,
      fence: 'fence-1',
    },
    task: spec.task,
    head: attempt.head,
    baselineFactRef: attempt.reference,
    factHistory: [
      {
        reference: attempt.reference,
        record: attempt.record,
        payload: attempt.payload,
      },
    ],
    observations: [
      observation({ number: 1, observedAt: graceAt }),
      observation({ number: 2, observedAt: secondAt }),
      observation({ number: 3, observedAt: thirdAt }),
    ],
    ...overrides,
  };
}

// ---- mark-lost-capability.spec.ts fixtures proper ----

const lease: MarkLostLeaseIdentity = {
  taskKey: 'task-1',
  ownerId: 'owner-1',
  fence: 1,
};

/** Mints a real eligibility receipt bound to the given lease's fence token. */
async function mintReceipt(mintLease: MarkLostLeaseIdentity = lease) {
  const base = await input();
  return validateMarkLostEligibility({
    ...base,
    authority: { ...base.authority, fence: markLostLeaseFence(mintLease) },
  });
}

function boundary(now: () => string) {
  return new MarkLostBoundary({ now });
}

const INVALID_MESSAGE = 'Mark-lost eligibility receipt is invalid';

describe('MarkLostBoundary', () => {
  it('verifies a real receipt minted under the matching lease fence', async () => {
    const receipt = await mintReceipt();
    const result = boundary(() => thirdAt).verify({ receipt, lease });
    expect(isVerifiedMarkLostTermination(result)).toBe(true);
    expect(result.terminatedAt).toBe(thirdAt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(isVerifiedMarkLostTermination({ ...result })).toBe(false);
  });

  it('carries the original receipt object by reference so the fence re-checks against the same identity', async () => {
    const receipt = await mintReceipt();
    const result = boundary(() => thirdAt).verify({ receipt, lease });
    expect(result.receipt).toBe(receipt);
    expect(isMarkLostEligibilityReceipt(result.receipt)).toBe(true);
    expect(
      hasMarkLostEligibilityFence(result.receipt, markLostLeaseFence(lease)),
    ).toBe(true);
  });

  it('rejects a receipt minted under a different lease fence incarnation', async () => {
    const receipt = await mintReceipt(lease);
    expect(() =>
      boundary(() => thirdAt).verify({
        receipt,
        lease: { ...lease, fence: 2 },
      }),
    ).toThrow(INVALID_MESSAGE);
  });

  it('rejects a receipt minted under a different ownerId', async () => {
    const receipt = await mintReceipt(lease);
    expect(() =>
      boundary(() => thirdAt).verify({
        receipt,
        lease: { ...lease, ownerId: 'owner-2' },
      }),
    ).toThrow(INVALID_MESSAGE);
  });

  it('rejects a receipt minted under a different taskKey', async () => {
    const receipt = await mintReceipt(lease);
    expect(() =>
      boundary(() => thirdAt).verify({
        receipt,
        lease: { ...lease, taskKey: 'task-2' },
      }),
    ).toThrow(INVALID_MESSAGE);
  });

  it('rejects forged or structurally-shaped input', async () => {
    const receipt = await mintReceipt();
    const forgedShape = {
      schema: receipt.schema,
      version: receipt.version,
      receiptId: receipt.receiptId,
      eligibleAt: receipt.eligibleAt,
    };
    for (const candidate of [
      { ...receipt },
      undefined,
      null,
      'not-a-receipt',
      forgedShape,
    ]) {
      expect(() =>
        boundary(() => thirdAt).verify({ receipt: candidate, lease }),
      ).toThrow(INVALID_MESSAGE);
    }
  });

  it('rejects an invalid clock', async () => {
    const receipt = await mintReceipt();
    const invalidClocks: Array<() => string> = [
      () => 'not-a-date',
      () => '',
      () => '2026-08-15T05:00:00', // no trailing Z
      () => {
        throw new Error('clock unavailable');
      },
    ];
    for (const now of invalidClocks) {
      expect(() => boundary(now).verify({ receipt, lease })).toThrow(
        INVALID_MESSAGE,
      );
    }
  });

  it('rejects a clock strictly before eligibleAt and accepts one exactly at eligibleAt', async () => {
    const receipt = await mintReceipt();
    expect(receipt.eligibleAt).toBe(thirdAt);
    expect(() =>
      boundary(() => '2026-08-15T04:59:59.999Z').verify({ receipt, lease }),
    ).toThrow(INVALID_MESSAGE);
    const result = boundary(() => thirdAt).verify({ receipt, lease });
    expect(result.terminatedAt).toBe(thirdAt);
  });

  it('accepts a clock at eligibleAt expressed with different-but-equal instant precision', async () => {
    const receipt = await mintReceipt();
    expect(receipt.eligibleAt).toBe('2026-08-15T05:00:00.000Z');
    const result = boundary(() => '2026-08-15T05:00:00Z').verify({
      receipt,
      lease,
    });
    expect(result.terminatedAt).toBe('2026-08-15T05:00:00Z');
  });

  it('always throws the same terse message, never leaking fence, receipt id, or evidence', async () => {
    const receipt = await mintReceipt();
    const attempts: Array<() => unknown> = [
      () => boundary(() => thirdAt).verify({ receipt: undefined, lease }),
      () => boundary(() => thirdAt).verify({ receipt: { ...receipt }, lease }),
      () => boundary(() => 'garbage').verify({ receipt, lease }),
      () =>
        boundary(() => thirdAt).verify({
          receipt,
          lease: { ...lease, fence: lease.fence + 1 },
        }),
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toBe(INVALID_MESSAGE);
      expect(message).not.toContain(receipt.receiptId);
      expect(message).not.toContain(markLostLeaseFence(lease));
    }
  });
});

describe('markLostEventId', () => {
  const base = {
    attemptId: 'A'.repeat(22),
    launchOperationId: 'op-1',
    executionEpoch: 1,
    receiptId: 'receipt-1',
  };

  it('is deterministic for identical input and starts with mark-lost:', () => {
    const first = markLostEventId(base);
    const second = markLostEventId({ ...base });
    expect(first).toBe(second);
    expect(first.startsWith('mark-lost:')).toBe(true);
  });

  it('changes when attemptId changes', () => {
    expect(markLostEventId({ ...base, attemptId: 'B'.repeat(22) })).not.toBe(
      markLostEventId(base),
    );
  });

  it('changes when launchOperationId changes', () => {
    expect(markLostEventId({ ...base, launchOperationId: 'op-2' })).not.toBe(
      markLostEventId(base),
    );
  });

  it('changes when executionEpoch changes', () => {
    expect(markLostEventId({ ...base, executionEpoch: 2 })).not.toBe(
      markLostEventId(base),
    );
  });

  it('changes when receiptId changes', () => {
    expect(markLostEventId({ ...base, receiptId: 'receipt-2' })).not.toBe(
      markLostEventId(base),
    );
  });
});
