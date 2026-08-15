import { describe, expect, it } from 'vitest';

import { type AcceptedAttemptSpec, type RunBinding } from './attempt';
import {
  appendAttemptHistoryTransition,
  type AttemptCommandRecordPayload,
  AttemptHistoryCapacityError,
  type AttemptHistoryHead,
  attemptHistoryRecordReference,
  attemptHistoryTransitionDigest,
  attemptSpecDigest,
  createGenesisAttemptHistoryHead,
  projectLegacyAttemptState,
  registerAttemptHistory,
  resolveAttemptHistoryIdentityReplay,
} from './attempt-history';
import {
  canonicalDurableJson,
  LIFECYCLE_DURABILITY_LIMITS,
  serializedDurableByteLength,
  validateDurableValue,
} from './durability';
import {
  appendHistoryRecord,
  HistoryIntegrityError,
  historyPayloadDigest,
  historyRecordReference,
  sha256Digest,
} from './history';
import type { AgentResultClaimV1 } from './observation';

const at = '2026-08-15T12:00:00.000Z';
const later = '2026-08-15T12:05:00.000Z';
const deadline = '2026-08-15T12:10:00.000Z';
const attemptId = 'A'.repeat(22);
const sha = 'a'.repeat(64);
const workflowSha = 'b'.repeat(40);
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
  task: { tenantId: 'tenant-1', repositoryId: 123, issueNumber: 9 },
  activation: {
    activationId: 'activation-1',
    taskClassId: 'github-issue',
    authorityEpoch: 1,
    mode: 'central-authoritative',
  },
  local: {
    intentId: 'intent-1',
    generation: 1,
    attemptMarker: 'g1:intent-1',
    admissionRevision: 1,
    idempotencyKey: 'key-1',
  },
  execution: {
    workflowPath: binding.workflowPath,
    workflowRef: binding.workflowRef,
    workflowSha,
    mode: 'implement',
    executorId: 'executor-1',
    credentialProfileId: 'profile-1',
    renewalDeadline: '2026-08-15T13:00:00.000Z',
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
    decidedAt: at,
  },
};

function registered() {
  return registerAttemptHistory({
    tenantId: 'tenant-1',
    attemptId,
    spec,
    specDigest: attemptSpecDigest(spec),
    updatedAt: at,
  });
}

function fact(factId: string, payload: Record<string, unknown>) {
  const runtimePayload =
    payload.kind === 'run-bound'
      ? { kind: 'run-bound' as const, binding: payload.binding }
      : payload.kind === 'run-terminal'
        ? {
            kind: 'run-terminal' as const,
            binding: payload.binding,
            conclusion: payload.conclusion,
            observedAt: payload.observedAt,
          }
        : payload.kind === 'agent-result-claim'
          ? { kind: 'agent-result-claim' as const, claim: payload.claim }
          : payload;
  const envelope = {
    schema: 'agent-lcars.runtime-observation/v1' as const,
    version: 1 as const,
    requestId: `request-${factId}`,
    factId,
    attemptId,
    tenant: spec.tenant,
    task: spec.task,
    source: { kind: 'github-provider' as const, sourceId: 'github-1' },
    observedAt: later,
    payloadSha256: sha256Digest(canonicalDurableJson(runtimePayload)),
    payload: runtimePayload,
  };
  return {
    schema: 'agent-lcars.attempt-fact/v1' as const,
    version: 1 as const,
    factId,
    requestId: `request-${factId}`,
    source: { kind: 'github-provider' as const, sourceId: 'github-1' },
    observedAt: later,
    transitionedAt: later,
    payloadSha256: envelope.payloadSha256,
    canonicalDigest: attemptHistoryTransitionDigest({
      kind: 'observation',
      envelope,
      ...(payload.kind === 'run-terminal'
        ? { finalizationDeadline: payload.finalizationDeadline }
        : {}),
    }),
    payload,
  };
}

function command(
  payload: AttemptCommandRecordPayload['payload'],
  transitionedAt = later,
  claimFactId?: string,
): AttemptCommandRecordPayload {
  return {
    schema: 'agent-lcars.attempt-command/v1',
    version: 1,
    transitionedAt,
    canonicalDigest: attemptHistoryTransitionDigest({
      kind:
        payload.kind === 'validate-claim-requested'
          ? 'validate-claim'
          : payload.kind,
      eventId: payload.commandId,
      ...(payload.kind === 'start-validation' ? { at: payload.at } : {}),
      ...(payload.kind === 'request-cancel' &&
      payload.supersededByIntentId !== undefined
        ? { supersededByIntentId: payload.supersededByIntentId }
        : {}),
      ...(payload.kind === 'validate-claim-requested'
        ? {
            claimFactId: claimFactId ?? payload.claimFactRef.recordDigest,
            validation: payload.validation,
          }
        : {}),
      ...('outcome' in payload ? { outcome: payload.outcome } : {}),
    }),
    payload,
  };
}

function lifecycleOutcome(input: {
  terminalState: 'failed' | 'cancelled' | 'superseded' | 'lost';
  execution: 'not_started' | 'cancelled' | 'lost' | 'timed_out';
  result?: 'none' | 'startup-failure';
  commandId: string;
  finalizedAt?: string;
  failure?: {
    owningSystem: 'runner';
    phase: 'launch';
    reason: 'launch_rejected';
    retryDisposition: 'manual';
  };
}) {
  return {
    schema: 'agent-lcars.attempt-outcome/v1' as const,
    version: 1 as const,
    attemptId,
    terminalState: input.terminalState,
    execution: input.execution,
    result: input.result ?? ('none' as const),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    evidence: {
      kind: 'lifecycle-decision' as const,
      decisionFactId: input.commandId,
    },
    evidenceValidation: { status: 'not-applicable' as const },
    finalizedAt: input.finalizedAt ?? later,
  };
}

function directTerminal(
  start: ReturnType<typeof registered>,
  payload: Extract<
    AttemptCommandRecordPayload['payload'],
    {
      kind: 'launch-rejected' | 'cancel-unlaunched' | 'mark-lost';
    }
  >,
) {
  const wrapped = command({
    ...payload,
    outcomeDigest: historyPayloadDigest(payload.outcome),
  });
  const commandRecord = appendHistoryRecord({
    head: start.head.streams.command,
    payload: wrapped,
    appliedRevision: 2,
  }).record;
  const outcomeDigest = historyPayloadDigest(payload.outcome);
  return appendAttemptHistoryTransition({
    head: start.head,
    nextRevision: 2,
    transitionedAt: later,
    emitted: [
      { stream: 'command', payload: wrapped },
      {
        stream: 'evidence',
        payload: {
          schema: 'agent-lcars.attempt-evidence/v1' as const,
          version: 1 as const,
          finalizeCommandRef: historyRecordReference(commandRecord),
          claimRefs: [],
          validationRefs: [],
          outcomeDigest,
          outcome: payload.outcome,
          transitionedAt: later,
        },
      },
    ],
  });
}

function appendClaim(
  current: ReturnType<typeof registered>,
  factId: string,
  claim: AgentResultClaimV1,
  revision: number,
  priorRecords: readonly {
    record: ReturnType<typeof appendHistoryRecord>['record'];
    payload: unknown;
  }[] = [],
) {
  const claimDigest = historyPayloadDigest({
    kind: 'agent-result-claim',
    claim,
  });
  const claimFact = fact(factId, {
    kind: 'agent-result-claim',
    claimFactId: factId,
    claimDigest,
    claim,
  });
  const claimFactRecord = appendHistoryRecord({
    head: current.head.streams.fact,
    payload: claimFact,
    appliedRevision: revision,
  }).record;
  const claimPayload = {
    schema: 'agent-lcars.attempt-claim/v1' as const,
    version: 1 as const,
    claimFactId: factId,
    factRef: attemptHistoryRecordReference(
      claimFactRecord,
      { tenantId: 'tenant-1', attemptId },
      'fact',
    ),
    requestId: `request-${factId}`,
    observedAt: later,
    transitionedAt: later,
    claimDigest,
    claim,
  };
  const appended = appendAttemptHistoryTransition({
    head: current.head,
    nextRevision: revision,
    transitionedAt: later,
    emitted: [
      { stream: 'fact', payload: claimFact },
      { stream: 'claim', payload: claimPayload },
    ],
    priorRecords,
  });
  return { ...appended, claimFact, claimPayload };
}

describe('bounded Attempt history contracts', () => {
  it('uses every external identity helper for scoped replay and conflicts', () => {
    const receipt = {
      kind: 'fact' as const,
      tenantId: 'tenant-1',
      attemptId,
      factId: 'fact-1',
      requestId: 'request-1',
      canonicalDigest: 'c'.repeat(64),
    };
    const receipts = [
      receipt,
      {
        kind: 'command' as const,
        tenantId: 'tenant-1',
        attemptId,
        commandId: 'command-1',
        canonicalDigest: 'c'.repeat(64),
      },
      {
        kind: 'claim' as const,
        tenantId: 'tenant-1',
        attemptId,
        claimFactId: 'claim-1',
        canonicalDigest: 'c'.repeat(64),
      },
      {
        kind: 'validation' as const,
        tenantId: 'tenant-1',
        attemptId,
        validationFactId: 'validation-1',
        canonicalDigest: 'c'.repeat(64),
      },
      {
        kind: 'outcome' as const,
        tenantId: 'tenant-1',
        attemptId,
        canonicalDigest: 'c'.repeat(64),
      },
    ];
    expect(
      resolveAttemptHistoryIdentityReplay({
        receipts,
        incoming: { ...receipt, requestId: 'request-retried' },
      }),
    ).toBe('replay');
    expect(
      resolveAttemptHistoryIdentityReplay({
        receipts,
        incoming: {
          kind: 'command',
          tenantId: 'tenant-1',
          attemptId,
          commandId: 'command-1',
          canonicalDigest: 'c'.repeat(64),
        },
      }),
    ).toBe('replay');
    expect(
      resolveAttemptHistoryIdentityReplay({
        receipts,
        incoming: {
          kind: 'claim',
          tenantId: 'tenant-1',
          attemptId,
          claimFactId: 'claim-1',
          canonicalDigest: 'c'.repeat(64),
        },
      }),
    ).toBe('replay');
    expect(
      resolveAttemptHistoryIdentityReplay({
        receipts,
        incoming: {
          kind: 'validation',
          tenantId: 'tenant-1',
          attemptId,
          validationFactId: 'validation-1',
          canonicalDigest: 'c'.repeat(64),
        },
      }),
    ).toBe('replay');
    expect(
      resolveAttemptHistoryIdentityReplay({
        receipts,
        incoming: {
          kind: 'evidence',
          tenantId: 'tenant-1',
          attemptId,
          canonicalDigest: 'c'.repeat(64),
        },
      }),
    ).toBe('replay');
    expect(() =>
      resolveAttemptHistoryIdentityReplay({
        receipts,
        incoming: { ...receipt, canonicalDigest: 'd'.repeat(64) },
      }),
    ).toThrow();
    for (const incoming of [
      {
        kind: 'command' as const,
        tenantId: 'tenant-1',
        attemptId,
        commandId: 'command-1',
        canonicalDigest: 'd'.repeat(64),
      },
      {
        kind: 'claim' as const,
        tenantId: 'tenant-1',
        attemptId,
        claimFactId: 'claim-1',
        canonicalDigest: 'd'.repeat(64),
      },
      {
        kind: 'validation' as const,
        tenantId: 'tenant-1',
        attemptId,
        validationFactId: 'validation-1',
        canonicalDigest: 'd'.repeat(64),
      },
      {
        kind: 'outcome' as const,
        tenantId: 'tenant-1',
        attemptId,
        canonicalDigest: 'd'.repeat(64),
      },
    ]) {
      expect(() =>
        resolveAttemptHistoryIdentityReplay({ receipts, incoming }),
      ).toThrow();
    }
    expect(() =>
      resolveAttemptHistoryIdentityReplay({
        receipts,
        incoming: { ...receipt, tenantId: 'tenant-foreign' },
      }),
    ).toThrow();
  });

  it('rejects a tampered runtime payload digest', () => {
    const start = registered();
    const bound = fact('bound-tamper', { kind: 'run-bound', binding });
    expect(() =>
      appendAttemptHistoryTransition({
        head: start.head,
        nextRevision: 2,
        transitionedAt: later,
        emitted: [
          {
            stream: 'fact',
            payload: { ...bound, payloadSha256: 'd'.repeat(64) },
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts a late bound run without reviving cancellation', () => {
    const start = registered();
    const cancelPayload = {
      kind: 'request-cancel' as const,
      commandId: 'cancel-1',
    };
    const cancelling = appendAttemptHistoryTransition({
      head: start.head,
      nextRevision: 2,
      transitionedAt: later,
      emitted: [
        {
          stream: 'command',
          payload: {
            schema: 'agent-lcars.attempt-command/v1' as const,
            version: 1 as const,
            transitionedAt: later,
            canonicalDigest: attemptHistoryTransitionDigest({
              kind: 'request-cancel',
              eventId: cancelPayload.commandId,
            }),
            payload: cancelPayload,
          },
        },
      ],
    });
    const bound = appendAttemptHistoryTransition({
      head: cancelling.head,
      nextRevision: 3,
      transitionedAt: later,
      emitted: [
        {
          stream: 'fact',
          payload: fact('late-bound', { kind: 'run-bound', binding }),
        },
      ],
    });
    expect(bound.head.phase).toBe('cancelling');
    expect(bound.head.launch.state).toBe('accepted');
  });

  it('creates detached, deeply frozen genesis and registration state', () => {
    const genesis: AttemptHistoryHead = createGenesisAttemptHistoryHead({
      tenantId: 'tenant-1',
      attemptId,
      spec,
      specDigest: attemptSpecDigest(spec),
      updatedAt: at,
    });
    const result = registered();
    expect(genesis.aggregateRevision).toBe(0);
    expect(result.head.aggregateRevision).toBe(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.head.spec.execution)).toBe(true);
    expect(() => {
      (result.head.spec.execution as { executorId: string }).executorId =
        'mutated';
    }).toThrow();
  });

  it('projects legacy inline state without changing the durable head meaning', () => {
    const start = registered();
    const legacy = {
      schema: 'agent-lcars.attempt-state/v1' as const,
      version: 1 as const,
      spec,
      specDigest: attemptSpecDigest(spec),
      revision: start.head.aggregateRevision,
      phase: 'launch-pending' as const,
      launch: start.head.launch,
      executionEpoch: start.head.executionEpoch,
      facts: [],
      commands: [
        {
          eventId: attemptId,
          canonicalDigest: start.records[0]!.payloadDigest,
        },
      ],
      pendingClaims: [],
      futureGrantsDenied: start.head.futureGrantsDenied,
      updatedAt: start.head.updatedAt,
    };
    const projection = projectLegacyAttemptState(legacy);
    expect(projection.legacyInline).toBe(true);
    expect(projection.head.aggregateRevision).toBe(legacy.revision);
    expect(projection.head.phase).toBe(legacy.phase);
    expect(projection.head.launch).toEqual(legacy.launch);
    expect(projection.inline.state.spec).toEqual(spec);
    expect(Object.isFrozen(projection.head)).toBe(true);
    expect(Object.isFrozen(projection.inline.state.spec)).toBe(true);
  });

  it('derives an exact binding and never accepts a caller-supplied head patch', () => {
    const start = registered();
    const next = appendAttemptHistoryTransition({
      head: start.head,
      nextRevision: 2,
      transitionedAt: later,
      emitted: [
        {
          stream: 'fact',
          payload: fact('bound-1', { kind: 'run-bound', binding }),
        },
      ],
    });
    expect(next.head.binding).toEqual(binding);
    expect(next.head.spec).toEqual(start.head.spec);
    expect(next.head.launch.state).toBe('accepted');
    expect(next.head.executionEpoch).toBe(start.head.executionEpoch);
  });

  it('preserves terminal-before-binding and rejects a mismatched later binding or duplicate terminal', () => {
    const start = registered();
    const terminal = fact('terminal-1', {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: later,
      finalizationDeadline: deadline,
    });
    const pending = appendAttemptHistoryTransition({
      head: start.head,
      nextRevision: 2,
      transitionedAt: later,
      emitted: [{ stream: 'fact', payload: terminal }],
    });
    expect(pending.head.pendingTerminal?.finalizationDeadline).toBe(deadline);
    expect(() =>
      appendAttemptHistoryTransition({
        head: pending.head,
        nextRevision: 3,
        transitionedAt: later,
        emitted: [
          {
            stream: 'fact',
            payload: fact('wrong-bound', {
              kind: 'run-bound',
              binding: { ...binding, checkRunId: 12 },
            }),
          },
        ],
      }),
    ).toThrow();
    const promoted = appendAttemptHistoryTransition({
      head: pending.head,
      nextRevision: 3,
      transitionedAt: later,
      emitted: [
        {
          stream: 'fact',
          payload: fact('bound-1', { kind: 'run-bound', binding }),
        },
      ],
    });
    expect(promoted.head.finalization?.closesAt).toBe(deadline);
    expect(() =>
      appendAttemptHistoryTransition({
        head: promoted.head,
        nextRevision: 4,
        transitionedAt: later,
        emitted: [{ stream: 'fact', payload: terminal }],
      }),
    ).toThrow();
  });

  it('rejects oversized fanout before producing a head', () => {
    const start = registered();
    const heartbeat = {
      stream: 'fact' as const,
      payload: fact('beat-1', {
        kind: 'heartbeat',
        grantId: 'grant-1',
        at: later,
        phase: 'bootstrap',
      }),
    };
    expect(() =>
      appendAttemptHistoryTransition({
        head: start.head,
        nextRevision: 2,
        transitionedAt: later,
        emitted: Array.from({ length: 65 }, () => heartbeat),
      }),
    ).toThrow(AttemptHistoryCapacityError);
  });

  it('enforces exact byte boundaries for attempt heads and transitions', () => {
    const exactSerializedString = (limit: number) => 'x'.repeat(limit - 2);
    for (const limit of [
      LIFECYCLE_DURABILITY_LIMITS.attemptHeadBytes,
      LIFECYCLE_DURABILITY_LIMITS.transitionBytes,
    ]) {
      const exact = exactSerializedString(limit);
      expect(serializedDurableByteLength(exact)).toBe(limit);
      const budget: 'attemptHeadBytes' | 'transitionBytes' =
        limit === LIFECYCLE_DURABILITY_LIMITS.attemptHeadBytes
          ? 'attemptHeadBytes'
          : 'transitionBytes';
      expect(validateDurableValue(exact, budget)).toBe(exact);
      expect(() => validateDurableValue(`${exact}x`, budget)).toThrow(
        AttemptHistoryCapacityError,
      );
    }
  });

  it.each([
    ['launch rejection', 'launch-rejected', 'startup-failure'],
    ['unlaunched cancellation', 'cancel-unlaunched', 'none'],
    ['lost run', 'mark-lost', 'none'],
  ] as const)(
    'persists the direct %s command and evidence atomically',
    (_label, kind, result) => {
      const start = registered();
      const execution =
        kind === 'mark-lost'
          ? 'lost'
          : kind === 'cancel-unlaunched'
            ? 'not_started'
            : 'not_started';
      const failure =
        kind === 'launch-rejected'
          ? {
              owningSystem: 'runner' as const,
              phase: 'launch' as const,
              reason: 'launch_rejected' as const,
              retryDisposition: 'manual' as const,
            }
          : undefined;
      const outcome = lifecycleOutcome({
        commandId: `${kind}-command`,
        terminalState:
          kind === 'mark-lost'
            ? 'lost'
            : kind === 'cancel-unlaunched'
              ? 'cancelled'
              : 'failed',
        execution,
        result,
        failure,
      });
      const transition = directTerminal(start, {
        kind,
        commandId: `${kind}-command`,
        outcomeDigest: historyPayloadDigest(outcome),
        outcome,
      });
      expect(transition.head.phase).toBe('terminal');
      expect(transition.head.outcomeRef?.streamKind).toBe('evidence');
      expect(transition.records.map((record) => record.streamKind)).toEqual([
        'command',
        'evidence',
      ]);
    },
  );

  it('rejects a sequence-overflow stream before appending a record', () => {
    const start = registered();
    const overflow = {
      ...start.head,
      streams: {
        ...start.head.streams,
        fact: {
          ...start.head.streams.fact,
          count: Number.MAX_SAFE_INTEGER,
          lastSequence: Number.MAX_SAFE_INTEGER,
          headDigest: sha,
          lastAppliedRevision: start.head.aggregateRevision,
        },
      },
    };
    expect(() =>
      appendAttemptHistoryTransition({
        head: overflow,
        nextRevision: 2,
        transitionedAt: later,
        emitted: [
          {
            stream: 'fact',
            payload: fact('overflow-fact', {
              kind: 'heartbeat',
              grantId: 'grant-overflow',
              at: later,
              phase: 'bootstrap',
            }),
          },
        ],
      }),
    ).toThrow(HistoryIntegrityError);
  });

  it('keeps each stream contiguous while allowing idle revisions in other streams', () => {
    const start = registered();
    const bound = appendAttemptHistoryTransition({
      head: start.head,
      nextRevision: 2,
      transitionedAt: later,
      emitted: [
        {
          stream: 'fact',
          payload: fact('bound-contiguous', { kind: 'run-bound', binding }),
        },
      ],
    });
    const heartbeat = appendAttemptHistoryTransition({
      head: bound.head,
      nextRevision: 3,
      transitionedAt: later,
      emitted: [
        {
          stream: 'fact',
          payload: fact('heartbeat-contiguous', {
            kind: 'heartbeat',
            grantId: 'grant-1',
            at: later,
            phase: 'bootstrap',
          }),
        },
      ],
    });
    expect(heartbeat.records[0]?.sequence).toBe(2);
    expect(heartbeat.head.streams.fact.lastAppliedRevision).toBe(3);
    expect(heartbeat.head.streams.command.count).toBe(1);
    expect(heartbeat.head.streams.command.lastAppliedRevision).toBe(1);
    expect(heartbeat.head.streams.claim.count).toBe(0);
  });

  it('executes start-validation, validate-claim, and finalize with closed evidence', () => {
    const start = registered();
    const bound = appendAttemptHistoryTransition({
      head: start.head,
      nextRevision: 2,
      transitionedAt: later,
      emitted: [
        {
          stream: 'fact',
          payload: fact('bound-validation', { kind: 'run-bound', binding }),
        },
      ],
    });
    const terminalPayload = fact('terminal-validation', {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: later,
      finalizationDeadline: deadline,
    });
    const terminal = appendAttemptHistoryTransition({
      head: bound.head,
      nextRevision: 3,
      transitionedAt: later,
      emitted: [{ stream: 'fact', payload: terminalPayload }],
    });
    const identity = { tenantId: 'tenant-1', attemptId };
    const terminalRef = attemptHistoryRecordReference(
      terminal.records[0]!,
      identity,
      'fact',
    );
    const claimValue = {
      kind: 'structured-no-op' as const,
      commentId: 'comment-validation',
      localAttemptMarker: spec.local.attemptMarker,
    };
    const claimDigest = historyPayloadDigest({
      kind: 'agent-result-claim',
      claim: claimValue,
    });
    const claimFact = fact('claim-validation', {
      kind: 'agent-result-claim',
      claimFactId: 'claim-validation',
      claimDigest,
      claim: claimValue,
    });
    const claimFactRecord = appendHistoryRecord({
      head: terminal.head.streams.fact,
      payload: claimFact,
      appliedRevision: 4,
    }).record;
    const claim = {
      schema: 'agent-lcars.attempt-claim/v1' as const,
      version: 1 as const,
      claimFactId: 'claim-validation',
      factRef: attemptHistoryRecordReference(claimFactRecord, identity, 'fact'),
      requestId: 'claim-request-validation',
      observedAt: later,
      transitionedAt: later,
      claimDigest,
      claim: claimValue,
    };
    const claimed = appendAttemptHistoryTransition({
      head: terminal.head,
      nextRevision: 4,
      transitionedAt: later,
      emitted: [
        { stream: 'fact', payload: claimFact },
        { stream: 'claim', payload: claim },
      ],
    });
    const claimRef = attemptHistoryRecordReference(
      claimed.records[1]!,
      identity,
      'claim',
    );
    const validationAt = '2026-08-15T12:11:00.000Z';
    const startValidation = command(
      {
        kind: 'start-validation',
        commandId: 'start-validation-command',
        at: validationAt,
        terminalFactRef: terminalRef,
      },
      validationAt,
    );
    const validating = appendAttemptHistoryTransition({
      head: claimed.head,
      nextRevision: 5,
      transitionedAt: validationAt,
      emitted: [{ stream: 'command', payload: startValidation }],
      priorRecords: [
        {
          record: terminal.records[0]!,
          payload: structuredClone(terminalPayload),
        },
        { record: claimed.records[0]!, payload: structuredClone(claimFact) },
        { record: claimed.records[1]!, payload: structuredClone(claim) },
      ],
    });
    expect(validating.head.phase).toBe('validating');
    expect(claim.claim.localAttemptMarker).toBe(spec.local.attemptMarker);
    const validation = {
      status: 'validated' as const,
      validationFactId: 'validate-claim-command',
      validatedAt: validationAt,
    };
    const validateCommand = command(
      {
        kind: 'validate-claim-requested',
        commandId: 'validate-claim-command',
        terminalFactRef: terminalRef,
        claimFactRef: claimRef,
        validation,
      },
      validationAt,
      'claim-validation',
    );
    const validationRecordPayload = {
      schema: 'agent-lcars.attempt-validation/v1' as const,
      version: 1 as const,
      commandId: 'validate-claim-command',
      validationFactId: 'validate-claim-command',
      terminalFactRef: terminalRef,
      claimFactRef: claimRef,
      validatedAt: validationAt,
      transitionedAt: validationAt,
      validation,
    };
    const validated = appendAttemptHistoryTransition({
      head: validating.head,
      nextRevision: 6,
      transitionedAt: validationAt,
      emitted: [
        { stream: 'command', payload: validateCommand },
        { stream: 'validation', payload: validationRecordPayload },
      ],
      priorRecords: [
        {
          record: terminal.records[0]!,
          payload: structuredClone(terminalPayload),
        },
        { record: claimed.records[0]!, payload: structuredClone(claimFact) },
        { record: claimed.records[1]!, payload: structuredClone(claim) },
        {
          record: validating.records[0]!,
          payload: structuredClone(startValidation),
        },
      ],
    });
    expect(validated.head.finalization?.validationRefs).toHaveLength(1);
    const validationRef = attemptHistoryRecordReference(
      validated.records[1]!,
      identity,
      'validation',
    );
    const outcome = {
      schema: 'agent-lcars.attempt-outcome/v1' as const,
      version: 1 as const,
      attemptId,
      terminalState: 'succeeded' as const,
      execution: 'exited' as const,
      result: 'no-op' as const,
      evidence: {
        kind: 'validated-claim' as const,
        validationFactId: 'validate-claim-command',
        claim: claimValue,
      },
      evidenceValidation: validation,
      finalizedAt: validationAt,
    };
    const finalizeCommand = command(
      {
        kind: 'finalize',
        commandId: 'finalize-command',
        outcomeDigest: historyPayloadDigest(outcome),
        outcome,
      },
      validationAt,
    );
    const finalizeRecord = appendHistoryRecord({
      head: validated.head.streams.command,
      payload: finalizeCommand,
      appliedRevision: 7,
    }).record;
    const finalized = appendAttemptHistoryTransition({
      head: validated.head,
      nextRevision: 7,
      transitionedAt: validationAt,
      emitted: [
        { stream: 'command', payload: finalizeCommand },
        {
          stream: 'evidence',
          payload: {
            schema: 'agent-lcars.attempt-evidence/v1' as const,
            version: 1 as const,
            finalizeCommandRef: attemptHistoryRecordReference(
              finalizeRecord,
              identity,
              'command',
            ),
            terminalFactRef: terminalRef,
            claimRefs: [claimRef],
            validationRefs: [validationRef],
            outcomeDigest: historyPayloadDigest(outcome),
            outcome,
            transitionedAt: validationAt,
          },
        },
      ],
      priorRecords: [
        {
          record: terminal.records[0]!,
          payload: structuredClone(terminalPayload),
        },
        { record: claimed.records[0]!, payload: structuredClone(claimFact) },
        { record: claimed.records[1]!, payload: structuredClone(claim) },
        {
          record: validating.records[0]!,
          payload: structuredClone(startValidation),
        },
        {
          record: validated.records[0]!,
          payload: structuredClone(validateCommand),
        },
        {
          record: validated.records[1]!,
          payload: structuredClone(validationRecordPayload),
        },
      ],
    });
    expect(finalized.head.phase).toBe('terminal');
    expect(finalized.head.outcomeDigest).toBe(historyPayloadDigest(outcome));
  });

  it('keeps ambiguous multi-claim proof compatible with failure outcomes', () => {
    const start = registered();
    const bound = appendAttemptHistoryTransition({
      head: start.head,
      nextRevision: 2,
      transitionedAt: later,
      emitted: [
        {
          stream: 'fact',
          payload: fact('bound-ambiguous', { kind: 'run-bound', binding }),
        },
      ],
    });
    const terminalPayload = fact('terminal-ambiguous', {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: later,
      finalizationDeadline: deadline,
    });
    const terminal = appendAttemptHistoryTransition({
      head: bound.head,
      nextRevision: 3,
      transitionedAt: later,
      emitted: [{ stream: 'fact', payload: terminalPayload }],
    });
    const claimOne = appendClaim(
      terminal,
      'claim-ambiguous-1',
      {
        kind: 'structured-no-op',
        commentId: 'comment-ambiguous-1',
        localAttemptMarker: spec.local.attemptMarker,
      },
      4,
    );
    const claimTwo = appendClaim(
      claimOne,
      'claim-ambiguous-2',
      {
        kind: 'comment',
        commentId: 'comment-ambiguous-2',
        localAttemptMarker: spec.local.attemptMarker,
      },
      5,
      [
        {
          record: claimOne.records[1]!,
          payload: structuredClone(claimOne.claimPayload),
        },
      ],
    );
    const identity = { tenantId: 'tenant-1', attemptId };
    const terminalRef = attemptHistoryRecordReference(
      terminal.records[0]!,
      identity,
      'fact',
    );
    const claimOneRef = attemptHistoryRecordReference(
      claimOne.records[1]!,
      identity,
      'claim',
    );
    const claimTwoRef = attemptHistoryRecordReference(
      claimTwo.records[1]!,
      identity,
      'claim',
    );
    const validationAt = '2026-08-15T12:11:00.000Z';
    const startValidation = command(
      {
        kind: 'start-validation',
        commandId: 'start-ambiguous',
        at: validationAt,
        terminalFactRef: terminalRef,
      },
      validationAt,
    );
    const validating = appendAttemptHistoryTransition({
      head: claimTwo.head,
      nextRevision: 6,
      transitionedAt: validationAt,
      emitted: [{ stream: 'command', payload: startValidation }],
      priorRecords: [
        {
          record: terminal.records[0]!,
          payload: structuredClone(terminalPayload),
        },
        {
          record: claimOne.records[0]!,
          payload: structuredClone(claimOne.claimFact),
        },
        {
          record: claimTwo.records[0]!,
          payload: structuredClone(claimTwo.claimFact),
        },
        {
          record: claimOne.records[1]!,
          payload: structuredClone(claimOne.claimPayload),
        },
        {
          record: claimTwo.records[1]!,
          payload: structuredClone(claimTwo.claimPayload),
        },
      ],
    });

    // The resolver needs the exact suffixes, including payloads for both
    // claims.  Keep these references explicit so the proof cannot accidentally
    // pass by relying on an unverified pointer.
    const validationPrior = [
      {
        record: terminal.records[0]!,
        payload: structuredClone(terminalPayload),
      },
      {
        record: claimOne.records[0]!,
        payload: structuredClone(claimOne.claimFact),
      },
      {
        record: claimTwo.records[0]!,
        payload: structuredClone(claimTwo.claimFact),
      },
      {
        record: claimOne.records[1]!,
        payload: structuredClone(claimOne.claimPayload),
      },
      {
        record: claimTwo.records[1]!,
        payload: structuredClone(claimTwo.claimPayload),
      },
      {
        record: validating.records[0]!,
        payload: structuredClone(startValidation),
      },
    ];
    const validations = [] as Array<{
      record: ReturnType<typeof appendHistoryRecord>['record'];
      payload: unknown;
    }>;
    let current = validating;
    for (const [index, claimRef] of [claimOneRef, claimTwoRef].entries()) {
      const commandId = `validate-ambiguous-${index + 1}`;
      const validation = {
        status: 'validated' as const,
        validationFactId: commandId,
        validatedAt: validationAt,
      };
      const validateCommand = command(
        {
          kind: 'validate-claim-requested',
          commandId,
          terminalFactRef: terminalRef,
          claimFactRef: claimRef,
          validation,
        },
        validationAt,
        index === 0 ? 'claim-ambiguous-1' : 'claim-ambiguous-2',
      );
      const validationPayload = {
        schema: 'agent-lcars.attempt-validation/v1' as const,
        version: 1 as const,
        commandId,
        validationFactId: commandId,
        terminalFactRef: terminalRef,
        claimFactRef: claimRef,
        validatedAt: validationAt,
        transitionedAt: validationAt,
        validation,
      };
      const applied = appendAttemptHistoryTransition({
        head: current.head,
        nextRevision: 7 + index,
        transitionedAt: validationAt,
        emitted: [
          { stream: 'command', payload: validateCommand },
          { stream: 'validation', payload: validationPayload },
        ],
        priorRecords: [...validationPrior, ...validations],
      });
      validations.push(
        {
          record: applied.records[0]!,
          payload: structuredClone(validateCommand),
        },
        {
          record: applied.records[1]!,
          payload: structuredClone(validationPayload),
        },
      );
      current = applied;
    }
    const outcome = {
      schema: 'agent-lcars.attempt-outcome/v1' as const,
      version: 1 as const,
      attemptId,
      terminalState: 'failed' as const,
      execution: 'exited' as const,
      result: 'outcome-gate-failure' as const,
      failure: {
        owningSystem: 'finalizer' as const,
        phase: 'validation' as const,
        reason: 'deliverable_unattributable' as const,
        retryDisposition: 'manual' as const,
        evidenceRef: 'finalization-window',
      },
      evidence: {
        kind: 'no-deliverable' as const,
        terminalFactId: 'terminal-ambiguous',
      },
      evidenceValidation: {
        status: 'ambiguous' as const,
        validationFactId: 'finalize-ambiguous',
        candidateCount: 2,
        validatedAt: later,
      },
      finalizedAt: validationAt,
    };
    const finalizeCommand = command(
      {
        kind: 'finalize',
        commandId: 'finalize-ambiguous',
        outcomeDigest: historyPayloadDigest(outcome),
        outcome,
      },
      validationAt,
    );
    const finalizeRecord = appendHistoryRecord({
      head: current.head.streams.command,
      payload: finalizeCommand,
      appliedRevision: 9,
    }).record;
    const finalized = appendAttemptHistoryTransition({
      head: current.head,
      nextRevision: 9,
      transitionedAt: validationAt,
      emitted: [
        { stream: 'command', payload: finalizeCommand },
        {
          stream: 'evidence',
          payload: {
            schema: 'agent-lcars.attempt-evidence/v1' as const,
            version: 1 as const,
            finalizeCommandRef: attemptHistoryRecordReference(
              finalizeRecord,
              identity,
              'command',
            ),
            terminalFactRef: terminalRef,
            claimRefs: [claimOneRef, claimTwoRef],
            validationRefs: validations
              .filter(({ record }) => record.streamKind === 'validation')
              .map(({ record }) =>
                attemptHistoryRecordReference(record, identity, 'validation'),
              ),
            outcomeDigest: historyPayloadDigest(outcome),
            outcome,
            transitionedAt: validationAt,
          },
        },
      ],
      priorRecords: [...validationPrior, ...validations],
    });
    expect(finalized.head.phase).toBe('terminal');
    expect(finalized.head.outcomeDigest).toBe(historyPayloadDigest(outcome));
  });

  it('requires one primary event, one transition timestamp, and a bounded prior bundle', () => {
    const start = registered();
    const heartbeat = {
      stream: 'fact' as const,
      payload: fact('beat-1', {
        kind: 'heartbeat',
        grantId: 'grant-1',
        at: later,
        phase: 'bootstrap',
      }),
    };
    expect(() =>
      appendAttemptHistoryTransition({
        head: start.head,
        nextRevision: 2,
        transitionedAt: at,
        emitted: [heartbeat],
      }),
    ).toThrow();
    expect(() =>
      appendAttemptHistoryTransition({
        head: start.head,
        nextRevision: 2,
        transitionedAt: later,
        emitted: [heartbeat, heartbeat],
      }),
    ).toThrow();
    expect(() =>
      appendAttemptHistoryTransition({
        head: start.head,
        nextRevision: 2,
        transitionedAt: later,
        emitted: [heartbeat],
        priorRecords: Array.from({ length: 65 }, () => ({
          record: {} as never,
          payload: {},
        })),
      }),
    ).toThrow(HistoryIntegrityError);
  });

  it('requires the exact fact, marker, and prior bundle for a claim and rejects replay', () => {
    const start = registered();
    const bound = appendAttemptHistoryTransition({
      head: start.head,
      nextRevision: 2,
      transitionedAt: later,
      emitted: [
        {
          stream: 'fact',
          payload: fact('bound-1', { kind: 'run-bound', binding }),
        },
      ],
    });
    const claimValue = {
      kind: 'structured-no-op' as const,
      commentId: 'comment-1',
      localAttemptMarker: spec.local.attemptMarker,
    };
    const claimDigest = historyPayloadDigest({
      kind: 'agent-result-claim',
      claim: claimValue,
    });
    const claimFact = fact('claim-fact', {
      kind: 'agent-result-claim',
      claimFactId: 'claim-fact',
      claimDigest,
      claim: claimValue,
    });
    const factRef = historyRecordReference(
      appendHistoryRecord({
        head: bound.head.streams.fact,
        payload: claimFact,
        appliedRevision: 3,
      }).record,
    );
    const claim = {
      schema: 'agent-lcars.attempt-claim/v1' as const,
      version: 1 as const,
      claimFactId: 'claim-fact',
      factRef,
      requestId: 'claim-request',
      observedAt: later,
      transitionedAt: later,
      claimDigest,
      claim: claimValue,
    };
    const accepted = appendAttemptHistoryTransition({
      head: bound.head,
      nextRevision: 3,
      transitionedAt: later,
      emitted: [
        { stream: 'fact', payload: claimFact },
        { stream: 'claim', payload: claim },
      ],
    });
    expect(accepted.head.pendingClaimRefs).toHaveLength(1);
    expect(() =>
      appendAttemptHistoryTransition({
        head: accepted.head,
        nextRevision: 4,
        transitionedAt: later,
        emitted: [
          { stream: 'fact', payload: claimFact },
          { stream: 'claim', payload: claim },
        ],
        priorRecords: [{ record: accepted.records[1]!, payload: claim }],
      }),
    ).toThrow();
    expect(() =>
      appendAttemptHistoryTransition({
        head: bound.head,
        nextRevision: 3,
        transitionedAt: later,
        emitted: [
          { stream: 'fact', payload: claimFact },
          {
            stream: 'claim',
            payload: {
              ...claim,
              claim: { ...claimValue, localAttemptMarker: 'g2:intent-2' },
            },
          },
        ],
      }),
    ).toThrow();
  });
});
