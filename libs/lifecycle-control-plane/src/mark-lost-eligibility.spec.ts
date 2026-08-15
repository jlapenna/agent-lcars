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
  assertMarkLostReceiptReplay,
  hasMarkLostEligibilityFence,
  isMarkLostEligibilityReceipt,
  isVerifiedRunStuckObservation,
  MarkLostEligibilityConflict,
  markLostReceiptReplayMatches,
  RunStuckObservationBoundary,
  validateMarkLostEligibility,
} from './mark-lost-eligibility';

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

describe('mark-lost eligibility receipt', () => {
  it('accepts the exact grace and interval thresholds and mints an opaque frozen receipt', async () => {
    const receipt = validateMarkLostEligibility(await input());
    expect(receipt.eligibleAt).toBe(thirdAt);
    expect(receipt.policy.policyId).toBe('run_stuck/v1');
    expect(isMarkLostEligibilityReceipt(receipt)).toBe(true);
    expect(isMarkLostEligibilityReceipt({ ...receipt })).toBe(false);
    expect(hasMarkLostEligibilityFence(receipt, 'fence-1')).toBe(true);
    expect('fence' in receipt).toBe(false);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.observations)).toBe(true);
    expect(Object.isFrozen(receipt.binding)).toBe(true);
    expect(() => {
      (receipt.binding as { runId: number }).runId = 99;
    }).toThrow();
  });

  it('rejects grace and interval values one millisecond early or late', async () => {
    for (const observations of [
      [
        observation({ number: 1, observedAt: '2026-08-15T03:59:59.999Z' }),
        observation({ number: 2, observedAt: secondAt }),
        observation({ number: 3, observedAt: thirdAt }),
      ],
      [
        observation({ number: 1, observedAt: graceAt }),
        observation({ number: 2, observedAt: '2026-08-15T04:29:59.999Z' }),
        observation({ number: 3, observedAt: thirdAt }),
      ],
      [
        observation({ number: 1, observedAt: graceAt }),
        observation({ number: 2, observedAt: secondAt }),
        observation({ number: 3, observedAt: '2026-08-15T04:59:59.999Z' }),
      ],
      [
        observation({ number: 1, observedAt: '2026-08-15T04:00:00.001Z' }),
        observation({ number: 2, observedAt: '2026-08-15T04:30:00.001Z' }),
        observation({ number: 3, observedAt: '2026-08-15T05:00:00.001Z' }),
      ],
    ]) {
      const request = await input({ observations });
      expect(() => validateMarkLostEligibility(request)).toThrow(
        MarkLostEligibilityConflict,
      );
    }
  });

  it('fails closed for fourth, terminal/no-run/contradiction, replay mismatch, and non-nominal evidence', async () => {
    const fourth = [
      ...(await input()).observations,
      observation({ number: 4, observedAt: '2026-08-15T05:30:00.000Z' }),
    ];
    const fourthRequest = await input({ observations: fourth });
    expect(() => validateMarkLostEligibility(fourthRequest)).toThrow();
    for (const status of ['terminal', 'no-run', 'contradiction'] as const) {
      const base = await input();
      base.observations[1] = observation({
        number: 2,
        observedAt: secondAt,
        status,
      });
      expect(() => validateMarkLostEligibility(base)).toThrow(
        MarkLostEligibilityConflict,
      );
    }
    const first = validateMarkLostEligibility(await input());
    const exactReplay = validateMarkLostEligibility(await input());
    const changed = validateMarkLostEligibility(
      await input({
        observations: [
          observation({ number: 1, observedAt: graceAt }),
          observation({ number: 2, observedAt: secondAt }),
          observation({ number: 3, observedAt: thirdAt, proofSalt: 'changed' }),
        ],
      }),
    );
    expect(markLostReceiptReplayMatches(first, exactReplay)).toBe(true);
    expect(markLostReceiptReplayMatches(first, changed)).toBe(false);
    expect(() => assertMarkLostReceiptReplay(first, changed)).toThrow(
      MarkLostEligibilityConflict,
    );
    const forged = { ...(await input()).observations[0] };
    expect(isVerifiedRunStuckObservation(forged)).toBe(false);
    const forgedRequest = await input({
      observations: [forged, forged, forged],
    });
    expect(() => validateMarkLostEligibility(forgedRequest)).toThrow();
  });

  it('requires the sole exact run-bound history fact and current authority/state', async () => {
    const base = await input();
    expect(() =>
      validateMarkLostEligibility({
        ...base,
        baselineFactRef: { ...base.baselineFactRef, recordDigest: sha },
      }),
    ).toThrow();
    expect(() =>
      validateMarkLostEligibility({
        ...base,
        authority: { ...base.authority, attemptRevision: 1 },
      }),
    ).toThrow();
    expect(() =>
      validateMarkLostEligibility({
        ...base,
        authority: { ...base.authority, executionEpoch: 2 },
      }),
    ).toThrow();
    expect(() =>
      validateMarkLostEligibility({
        ...base,
        task: { ...spec.task, issueNumber: spec.task.issueNumber + 1 },
      }),
    ).toThrow(MarkLostEligibilityConflict);
    expect(() =>
      validateMarkLostEligibility({
        ...base,
        head: { ...base.head, phase: 'cancelling' },
      }),
    ).toThrow();
    const wrongRun = { ...binding, runId: 12 };
    const wrongRunRequest = await input({
      observations: [
        observation({
          number: 1,
          observedAt: graceAt,
          changedBinding: wrongRun,
        }),
        observation({
          number: 2,
          observedAt: secondAt,
          changedBinding: wrongRun,
        }),
        observation({
          number: 3,
          observedAt: thirdAt,
          changedBinding: wrongRun,
        }),
      ],
    });
    expect(() => validateMarkLostEligibility(wrongRunRequest)).toThrow();
  });

  it('rejects hostile verifier results without exposing provider material', () => {
    const valid = observation({ number: 1, observedAt: graceAt });
    for (const candidate of [
      new String('boxed'),
      { ...valid, providerBody: 'must-not-cross-boundary' },
      new Proxy(valid, {}),
    ]) {
      expect(() =>
        new RunStuckObservationBoundary({
          verifyRunStuck: () => candidate,
        }).verify({
          candidate: undefined,
        }),
      ).toThrow(MarkLostEligibilityConflict);
    }
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      new RunStuckObservationBoundary({ verifyRunStuck: () => cyclic }).verify({
        candidate: undefined,
      }),
    ).toThrow(MarkLostEligibilityConflict);
  });
});
