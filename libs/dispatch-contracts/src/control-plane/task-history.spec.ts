import { describe, expect, it } from 'vitest';

import { ActivationProvenance } from './activation';
import {
  DurabilityCapacityError,
  LIFECYCLE_DURABILITY_LIMITS,
} from './durability';
import { HistoryRecordReference } from './history';
import {
  createGenesisHistoryHead,
  createHistoryRecord,
  historyRecordReference,
} from './history';
import { CanonicalTaskIdentity, TenantRef } from './identity';
import {
  LegacyTaskIntentState,
  TaskFactHistoryPayload,
  TaskHistoryHead,
  TaskIntentHistoryPayload,
} from './task-history';
import {
  appendTaskAttemptAdmissionHistoryTransition,
  createGenesisTaskHistoryHead,
  createTaskFactHistoryRecord,
  createTaskIntentHistoryRecord,
  taskAttemptAdmissionHistoryPayloadSchema,
  taskFactHistoryPayloadSchema,
  taskHistoryAggregateId,
  taskHistoryHeadSchema,
  taskIntentHistoryPayloadSchema,
  upgradeLegacyTaskIntentState,
  validateTaskAttemptAdmissionHistoryTransition,
  validateTaskHistoryTransition,
  verifyTaskFactHistoryRecord,
  verifyTaskIntentHistoryRecord,
} from './task-history';

const tenant: TenantRef = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
};
const task: CanonicalTaskIdentity = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 9,
};
const activation: ActivationProvenance = {
  activationId: 'activation-1',
  taskClassId: 'github-issue',
  authorityEpoch: 1,
  mode: 'central-authoritative',
};
const timestamp = '2026-08-14T12:00:00.000Z';
const sha = 'a'.repeat(64);

function head(): TaskHistoryHead {
  return createGenesisTaskHistoryHead({
    tenant,
    task,
    activation,
    updatedAt: timestamp,
  });
}

function policy(
  factId: string,
  decision: 'accepted' | 'rejected' = 'accepted',
) {
  return {
    schema: 'agent-lcars.policy-decision/v1' as const,
    version: 1 as const,
    policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: sha },
    decision,
    ruleId: 'rule-1',
    sourceFactId: factId,
    principal: { kind: 'system' as const, systemId: 'system-1' },
    evidenceRef: `evidence-${factId}`,
    decidedAt: timestamp,
  };
}

function fact(
  factId: string,
  taskRevision: number,
  decision: 'accepted' | 'rejected' = 'accepted',
  resolutionIntentId = `intent-${factId}`,
  situation:
    'requested-work' | 'park' | 'cancel' | 'reconcile' = 'requested-work',
): TaskFactHistoryPayload {
  return {
    schema: 'agent-lcars.task-fact-history/v1',
    version: 1,
    task,
    factId,
    requestId: `request-${factId}`,
    sourceKey: `system:${factId}`,
    canonicalDigest: sha,
    situation,
    policyDecision: policy(factId, decision),
    resolution:
      decision === 'rejected'
        ? {
            kind: 'parked',
            taskRevision,
            intentId: resolutionIntentId,
            intentRevision: 1,
          }
        : {
            kind: 'desired',
            taskRevision,
            intentId: resolutionIntentId,
            intentRevision: 1,
          },
    acceptedAt: timestamp,
  };
}

function intent(
  intentId: string,
  sourceFactId: string,
  revision = 1,
  status: TaskIntentHistoryPayload['status'] = 'desired',
  decision: 'accepted' | 'rejected' = 'accepted',
): TaskIntentHistoryPayload {
  return {
    schema: 'agent-lcars.task-intent-history/v1',
    version: 1,
    task,
    intentId,
    revision,
    status,
    sourceFactId,
    policyDecision: policy(sourceFactId, decision),
    activation,
    createdAt: timestamp,
    semanticKey: `semantic-${intentId}`,
    semanticDigest: sha,
    orderingKey: { occurredAt: timestamp, tieBreaker: intentId },
  };
}

function outputRefs(
  streamKind: 'effect' | 'command' | 'presentation',
): HistoryRecordReference[] {
  return [
    historyRecordReference(
      createHistoryRecord({
        tenantId: tenant.tenantId,
        aggregateKind: 'task',
        aggregateId: taskHistoryAggregateId(task),
        streamKind,
        sequence: 1,
        previousRecordDigest: null,
        payload: { streamKind },
        appliedRevision: 1,
      }),
    ),
  ];
}

const admissionAttemptId = 'attempt-admission-1234567890123456';

function attemptRegistrationRef(
  attemptId = admissionAttemptId,
): HistoryRecordReference {
  return historyRecordReference(
    createHistoryRecord({
      tenantId: tenant.tenantId,
      aggregateKind: 'attempt',
      aggregateId: attemptId,
      streamKind: 'command',
      sequence: 1,
      previousRecordDigest: null,
      payload: {
        schema: 'agent-lcars.attempt-command/v1',
        version: 1,
        payload: {
          kind: 'attempt-registered',
          commandId: attemptId,
          specDigest: sha,
        },
      },
      appliedRevision: 1,
    }),
  );
}

function admissionPayload(
  overrides: Partial<{
    tenant: TenantRef;
    task: CanonicalTaskIdentity;
    intentId: string;
    intentRevision: number;
    attemptId: string;
    admissionRevision: number;
    admittedAt: string;
    inputDigest: string;
    specDigest: string;
    attemptRegistrationRef: HistoryRecordReference;
  }> = {},
) {
  const attemptId = overrides.attemptId ?? admissionAttemptId;
  return {
    schema: 'agent-lcars.task-attempt-admission-history/v1' as const,
    version: 1 as const,
    tenant: overrides.tenant ?? tenant,
    task: overrides.task ?? task,
    intentId: overrides.intentId ?? 'intent-fact-1',
    intentRevision: overrides.intentRevision ?? 1,
    attemptId,
    admissionRevision: overrides.admissionRevision ?? 1,
    admittedAt: overrides.admittedAt ?? timestamp,
    taskSnapshotDigest: sha,
    inputDigest: overrides.inputDigest ?? sha,
    specDigest: overrides.specDigest ?? sha,
    attemptRegistrationRef:
      overrides.attemptRegistrationRef ?? attemptRegistrationRef(attemptId),
  };
}

describe('bounded Task history contracts', () => {
  it('atomically advances admission by a pointer-only Task command record', () => {
    const selected = validateTaskHistoryTransition({
      head: head(),
      fact: fact('fact-1', 1),
      intents: [intent('intent-fact-1', 'fact-1')],
      appliedRevision: 1,
      desired: {
        task,
        intentId: 'intent-fact-1',
        intentRevision: 1,
        selectedAt: timestamp,
      },
      attempt: { kind: 'unlaunched', intentId: 'intent-fact-1' },
      updatedAt: timestamp,
      effectRefs: [],
      workRefs: [],
      presentationRefs: [],
    });
    const workHead = createGenesisHistoryHead({
      tenantId: tenant.tenantId,
      aggregateKind: 'task',
      aggregateId: selected.head.aggregateId,
      streamKind: 'command',
    });
    const payload = admissionPayload();
    expect(
      taskAttemptAdmissionHistoryPayloadSchema.safeParse({
        ...payload,
        providerFact: { provider: 'must-not-be-accepted' },
      }).success,
    ).toBe(false);

    const result = appendTaskAttemptAdmissionHistoryTransition({
      head: selected.head,
      workHead,
      payload,
    });
    expect(result.head.aggregateRevision).toBe(2);
    expect(result.head.factHead).toEqual(selected.head.factHead);
    expect(result.head.intentHead).toEqual(selected.head.intentHead);
    expect(result.head.desired).toEqual(selected.head.desired);
    expect(result.head.attempt).toEqual({
      kind: 'launched',
      intentId: 'intent-fact-1',
      intentRevision: 1,
      attemptId: admissionAttemptId,
      admissionRevision: 1,
      admittedAt: timestamp,
      staleForDesiredState: false,
      cancellationRequested: false,
    });
    expect(result.workRecord.sequence).toBe(1);
    expect(result.workRecord.appliedRevision).toBe(2);
    expect(result.workRecordRef).toEqual(
      historyRecordReference(result.workRecord),
    );
    expect(result.workHead.lastSequence).toBe(1);
    expect(result.workHead.lastAppliedRevision).toBe(2);

    expect(() =>
      validateTaskAttemptAdmissionHistoryTransition({
        head: selected.head,
        workHead,
        payload: admissionPayload({ admissionRevision: 0 }),
      }),
    ).toThrow();
    expect(() =>
      validateTaskAttemptAdmissionHistoryTransition({
        head: selected.head,
        workHead,
        payload: admissionPayload({
          attemptRegistrationRef: attemptRegistrationRef(
            'other-attempt-123456789012345',
          ),
        }),
      }),
    ).toThrow();
    expect(() =>
      validateTaskAttemptAdmissionHistoryTransition({
        head: selected.head,
        workHead,
        payload: admissionPayload({
          tenant: { ...tenant, installationId: tenant.installationId + 1 },
        }),
      }),
    ).toThrow();
    expect(() =>
      validateTaskAttemptAdmissionHistoryTransition({
        head: selected.head,
        workHead,
        payload: admissionPayload({
          tenant: { ...tenant, repository: 'octo/other' },
        }),
      }),
    ).toThrow();
    expect(() =>
      validateTaskAttemptAdmissionHistoryTransition({
        head: result.head,
        workHead: result.workHead,
        payload,
      }),
    ).toThrow();
  });

  it('creates strict payloads, stream-bound entries, and frozen heads', () => {
    const current = head();
    const factRecord = createTaskFactHistoryRecord({
      head: current.factHead,
      payload: fact('fact-1', 1),
      appliedRevision: 1,
    });
    const intentRecord = createTaskIntentHistoryRecord({
      head: current.intentHead,
      payload: intent('intent-1', 'fact-1'),
      appliedRevision: 1,
    });
    const malformedFact = {
      ...fact('fact-bad-source', 1),
      policyDecision: policy('different-fact'),
    };
    expect(() =>
      createTaskFactHistoryRecord({
        head: current.factHead,
        payload: malformedFact,
        appliedRevision: 1,
      }),
    ).toThrow();
    const malformedRecord = createHistoryRecord({
      tenantId: tenant.tenantId,
      aggregateKind: 'task',
      aggregateId: taskHistoryAggregateId(task),
      streamKind: 'fact',
      sequence: 1,
      previousRecordDigest: null,
      payload: malformedFact,
      appliedRevision: 1,
    });
    expect(() =>
      verifyTaskFactHistoryRecord(malformedRecord, malformedFact),
    ).toThrow();
    expect(factRecord.streamKind).toBe('fact');
    expect(intentRecord.streamKind).toBe('intent');
    expect(
      verifyTaskFactHistoryRecord(factRecord, fact('fact-1', 1)).factId,
    ).toBe('fact-1');
    expect(
      verifyTaskIntentHistoryRecord(intentRecord, intent('intent-1', 'fact-1'))
        .intentId,
    ).toBe('intent-1');
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.factHead)).toBe(true);
    expect(
      taskHistoryHeadSchema.safeParse({ ...current, facts: [] }).success,
    ).toBe(false);
    expect(
      taskFactHistoryPayloadSchema.safeParse({
        ...fact('fact-1', 1),
        providerToken: 'no',
      }).success,
    ).toBe(false);
    expect(
      taskIntentHistoryPayloadSchema.safeParse({
        ...intent('intent-1', 'fact-1'),
        providerToken: 'no',
      }).success,
    ).toBe(false);
  });

  it('keeps fact plus two replacement intents at one aggregate revision', () => {
    const first = validateTaskHistoryTransition({
      head: head(),
      fact: fact('fact-1', 1),
      intents: [intent('intent-fact-1', 'fact-1')],
      appliedRevision: 1,
      desired: {
        task,
        intentId: 'intent-fact-1',
        intentRevision: 1,
        selectedAt: timestamp,
      },
      attempt: { kind: 'unlaunched', intentId: 'intent-fact-1' },
      updatedAt: timestamp,
      effectRefs: [],
      workRefs: [],
      presentationRefs: [],
    });
    const result = validateTaskHistoryTransition({
      head: first.head,
      fact: fact('fact-2', 2, 'accepted', 'new'),
      intents: [
        intent('intent-fact-1', 'fact-2', 2, 'superseded'),
        intent('new', 'fact-2'),
      ],
      appliedRevision: 2,
      desired: {
        task,
        intentId: 'new',
        intentRevision: 1,
        selectedAt: timestamp,
        supersedesIntentId: 'intent-fact-1',
      },
      attempt: { kind: 'unlaunched', intentId: 'new' },
      updatedAt: timestamp,
      effectRefs: outputRefs('effect'),
      workRefs: outputRefs('command'),
      presentationRefs: outputRefs('presentation'),
    });
    expect(result.factRecord.appliedRevision).toBe(2);
    expect(
      result.intentRecords.map((record) => record.appliedRevision),
    ).toEqual([2, 2]);
    expect(result.intentRecords.map((record) => record.sequence)).toEqual([
      2, 3,
    ]);
    expect(result.head.aggregateRevision).toBe(2);
    expect(result.head.intentHead.lastAppliedRevision).toBe(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.head.desired)).toBe(true);
    expect(Object.isFrozen(result.intentRecords)).toBe(true);

    expect(() =>
      validateTaskHistoryTransition({
        head: head(),
        fact: fact('initial-revision-2', 1, 'accepted', 'initial-revision-2'),
        intents: [intent('initial-revision-2', 'initial-revision-2', 2)],
        appliedRevision: 1,
        desired: {
          task,
          intentId: 'initial-revision-2',
          intentRevision: 2,
          selectedAt: timestamp,
        },
        attempt: { kind: 'unlaunched', intentId: 'initial-revision-2' },
        updatedAt: timestamp,
        effectRefs: [],
        workRefs: [],
        presentationRefs: [],
      }),
    ).toThrow();

    const selfReplacementFact = fact(
      'self-replacement-fact',
      2,
      'accepted',
      'intent-fact-1',
    );
    expect(() =>
      validateTaskHistoryTransition({
        head: first.head,
        fact: selfReplacementFact,
        intents: [
          intent('intent-fact-1', 'self-replacement-fact', 2, 'superseded'),
          intent('intent-fact-1', 'self-replacement-fact', 1),
        ],
        appliedRevision: 2,
        desired: {
          task,
          intentId: 'intent-fact-1',
          intentRevision: 1,
          selectedAt: timestamp,
          supersedesIntentId: 'intent-fact-1',
        },
        attempt: { kind: 'unlaunched', intentId: 'intent-fact-1' },
        updatedAt: timestamp,
        effectRefs: [],
        workRefs: [],
        presentationRefs: [],
      }),
    ).toThrow();
  });

  it('rejects identity, source-fact, digest, and stream mistakes', () => {
    const current = head();
    expect(() =>
      createTaskFactHistoryRecord({
        head: current.intentHead,
        payload: fact('fact-1', 1),
        appliedRevision: 1,
      }),
    ).toThrow();
    const record = createTaskFactHistoryRecord({
      head: current.factHead,
      payload: fact('fact-1', 1),
      appliedRevision: 1,
    });
    expect(() =>
      verifyTaskFactHistoryRecord(record, {
        ...fact('fact-1', 1),
        canonicalDigest: 'b'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      validateTaskHistoryTransition({
        head: current,
        fact: fact('fact-2', 2),
        intents: [intent('bad', 'other-fact')],
        appliedRevision: 2,
        attempt: { kind: 'none' },
        updatedAt: timestamp,
        desired: undefined,
        effectRefs: [],
        workRefs: [],
        presentationRefs: [],
      }),
    ).toThrow();

    expect(() =>
      validateTaskHistoryTransition({
        head: current,
        fact: fact('fact-gap', 2),
        intents: [],
        appliedRevision: 2,
        desired: undefined,
        attempt: { kind: 'none' },
        updatedAt: timestamp,
        effectRefs: [],
        workRefs: [],
        presentationRefs: [],
      }),
    ).toThrow();

    expect(() =>
      validateTaskHistoryTransition({
        head: current,
        fact: fact('fact-1', 1),
        intents: [intent('intent-fact-1', 'fact-1')],
        appliedRevision: 1,
        desired: {
          task,
          intentId: 'intent-fact-1',
          intentRevision: 1,
          selectedAt: timestamp,
        },
        attempt: { kind: 'unlaunched', intentId: 'intent-fact-1' },
        updatedAt: timestamp,
        effectRefs: outputRefs('command'),
        workRefs: [],
        presentationRefs: [],
      }),
    ).toThrow();
  });

  it('distinguishes policy-rejected requested work from operator parking', () => {
    const rejectedWithoutPrior = validateTaskHistoryTransition({
      head: head(),
      fact: fact('rejected-1', 1, 'rejected', 'parked-1'),
      intents: [intent('parked-1', 'rejected-1', 1, 'parked', 'rejected')],
      appliedRevision: 1,
      desired: undefined,
      attempt: { kind: 'none' },
      updatedAt: timestamp,
      effectRefs: [],
      workRefs: [],
      presentationRefs: [],
    });
    expect(rejectedWithoutPrior.head.desired).toBeUndefined();
    expect(rejectedWithoutPrior.head.attempt).toEqual({ kind: 'none' });

    const first = validateTaskHistoryTransition({
      head: head(),
      fact: fact('prior-1', 1, 'accepted', 'prior-intent'),
      intents: [intent('prior-intent', 'prior-1')],
      appliedRevision: 1,
      desired: {
        task,
        intentId: 'prior-intent',
        intentRevision: 1,
        selectedAt: timestamp,
      },
      attempt: { kind: 'unlaunched', intentId: 'prior-intent' },
      updatedAt: timestamp,
      effectRefs: [],
      workRefs: [],
      presentationRefs: [],
    });
    const rejectedWithPrior = validateTaskHistoryTransition({
      head: first.head,
      fact: fact('rejected-2', 2, 'rejected', 'parked-2'),
      intents: [intent('parked-2', 'rejected-2', 1, 'parked', 'rejected')],
      appliedRevision: 2,
      desired: first.head.desired,
      attempt: first.head.attempt,
      updatedAt: timestamp,
      effectRefs: [],
      workRefs: [],
      presentationRefs: [],
    });
    expect(rejectedWithPrior.head.desired?.intentId).toBe('prior-intent');
    expect(rejectedWithPrior.head.attempt).toEqual(first.head.attempt);

    const parked = validateTaskHistoryTransition({
      head: first.head,
      fact: {
        ...fact('operator-park', 2, 'accepted', 'prior-intent'),
        situation: 'park',
        resolution: {
          kind: 'parked',
          taskRevision: 2,
          intentId: 'prior-intent',
          intentRevision: 2,
        },
      },
      intents: [intent('prior-intent', 'operator-park', 2, 'parked')],
      appliedRevision: 2,
      desired: undefined,
      attempt: { kind: 'none' },
      updatedAt: timestamp,
      effectRefs: [],
      workRefs: [],
      presentationRefs: [],
    });
    expect(parked.head.desired).toBeUndefined();
    expect(parked.head.attempt).toEqual({ kind: 'none' });
  });

  it('preserves every admitted relation field when cancelling an operator task', () => {
    const selected = validateTaskHistoryTransition({
      head: head(),
      fact: fact('launch-1', 1, 'accepted', 'launch-intent'),
      intents: [intent('launch-intent', 'launch-1')],
      appliedRevision: 1,
      desired: {
        task,
        intentId: 'launch-intent',
        intentRevision: 1,
        selectedAt: timestamp,
      },
      attempt: { kind: 'unlaunched', intentId: 'launch-intent' },
      updatedAt: timestamp,
      effectRefs: [],
      workRefs: [],
      presentationRefs: [],
    });
    const launched = taskHistoryHeadSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...selected.head,
          attempt: {
            kind: 'launched',
            intentId: 'launch-intent',
            intentRevision: 1,
            attemptId: 'attempt-123456789012345678',
            admissionRevision: 1,
            admittedAt: timestamp,
            staleForDesiredState: false,
            cancellationRequested: false,
          },
        }),
      ),
    );
    if (launched.attempt.kind !== 'launched') throw new Error('test fixture');
    const launchedAttempt = launched.attempt;
    expect(
      taskHistoryHeadSchema.safeParse({
        ...launched,
        desired: {
          task,
          intentId: 'different-current-intent',
          intentRevision: 1,
          selectedAt: timestamp,
        },
      }).success,
    ).toBe(false);
    const cancelled = validateTaskHistoryTransition({
      head: launched,
      fact: {
        ...fact('operator-cancel', 2, 'accepted', 'launch-intent'),
        situation: 'cancel',
        resolution: {
          kind: 'cancelled',
          taskRevision: 2,
          intentId: 'launch-intent',
          intentRevision: 2,
        },
      },
      intents: [intent('launch-intent', 'operator-cancel', 2, 'cancelled')],
      appliedRevision: 2,
      desired: undefined,
      attempt: {
        ...launchedAttempt,
        staleForDesiredState: true,
        cancellationRequested: true,
      },
      updatedAt: timestamp,
      effectRefs: [],
      workRefs: [],
      presentationRefs: [],
    });
    expect(cancelled.head.attempt).toMatchObject({
      attemptId: launchedAttempt.attemptId,
      admissionRevision: launchedAttempt.admissionRevision,
      admittedAt: launchedAttempt.admittedAt,
      staleForDesiredState: true,
      cancellationRequested: true,
    });
  });

  it('requires exact policy, acceptance time, activation, and situation linkage', () => {
    const current = head();
    const base = fact('linked-1', 1);
    const desired = {
      task,
      intentId: 'linked-intent',
      intentRevision: 1,
      selectedAt: timestamp,
    };
    const attempt = { kind: 'unlaunched' as const, intentId: 'linked-intent' };
    const transition = (
      candidate: TaskIntentHistoryPayload,
      candidateFact = base,
    ) =>
      validateTaskHistoryTransition({
        head: current,
        fact: candidateFact,
        intents: [candidate],
        appliedRevision: 1,
        desired,
        attempt,
        updatedAt: timestamp,
        effectRefs: [],
        workRefs: [],
        presentationRefs: [],
      });
    expect(() =>
      transition({
        ...intent('linked-intent', 'linked-1'),
        createdAt: '2026-08-14T12:00:01.000Z',
      }),
    ).toThrow();
    expect(() =>
      transition({
        ...intent('linked-intent', 'linked-1'),
        policyDecision: {
          ...policy('linked-1'),
          ruleId: 'different-rule',
        },
      }),
    ).toThrow();
    expect(() =>
      transition(intent('linked-intent', 'linked-1'), {
        ...base,
        situation: 'park',
      }),
    ).toThrow();
    expect(() =>
      transition({
        ...intent('linked-intent', 'linked-1'),
        activation: { ...activation, authorityEpoch: 2 },
      }),
    ).toThrow();
  });

  it('upgrades legacy state in append order and derives intent revisions from facts', () => {
    const state: LegacyTaskIntentState = {
      schema: 'agent-lcars.task-intent-state/v1',
      version: 1,
      tenant,
      task,
      revision: 3,
      activation,
      facts: [fact('fact-1', 1), fact('fact-2', 2)].map(
        ({ task: _task, schema: _schema, version: _version, ...value }) =>
          value,
      ),
      intents: [
        intent('old', 'fact-2', 1, 'superseded'),
        intent('new', 'fact-2'),
      ].map(({ schema: _schema, version: _version, ...value }) => ({
        ...value,
        task: { ...value.task },
        activation: { ...value.activation },
      })),
      desired: {
        task: { ...task },
        intentId: 'new',
        intentRevision: 1,
        selectedAt: timestamp,
        supersedesIntentId: 'old',
      },
      attempt: { kind: 'unlaunched', intentId: 'new' },
      updatedAt: timestamp,
    };
    const upgraded = upgradeLegacyTaskIntentState({ state });
    expect(upgraded.factRecords.map((record) => record.sequence)).toEqual([
      1, 2,
    ]);
    expect(upgraded.intentRecords.map((record) => record.sequence)).toEqual([
      1, 2,
    ]);
    expect(
      upgraded.intentRecords.map((record) => record.appliedRevision),
    ).toEqual([2, 2]);
    expect(upgraded.head.aggregateRevision).toBe(3);
    expect(upgraded.head.desired?.intentId).toBe('new');
  });

  it('infers reconcile situation for legacy observed facts during upgrade', () => {
    const {
      schema: _schema,
      version: _version,
      task: _task,
      situation: _situation,
      ...legacyFact
    } = {
      ...fact('observed', 1),
      resolution: { kind: 'observed' as const, taskRevision: 1 },
    };
    const state: LegacyTaskIntentState = {
      schema: 'agent-lcars.task-intent-state/v1',
      version: 1,
      tenant,
      task,
      intents: [],
      revision: 1,
      activation,
      facts: [legacyFact],
      attempt: { kind: 'none' },
      updatedAt: timestamp,
    };
    const upgraded = upgradeLegacyTaskIntentState({ state });
    expect(upgraded.factRecords).toHaveLength(1);
  });

  it('rejects missing source facts and never truncates over-budget history', () => {
    const state: LegacyTaskIntentState = {
      schema: 'agent-lcars.task-intent-state/v1',
      version: 1,
      tenant,
      task,
      revision: 1,
      activation,
      facts: [],
      intents: [intent('orphan', 'missing')].map(
        ({ schema: _schema, version: _version, ...value }) => value,
      ),
      attempt: { kind: 'none' },
      updatedAt: timestamp,
    };
    expect(() => upgradeLegacyTaskIntentState({ state })).toThrow();
    expect(() =>
      validateTaskHistoryTransition({
        head: head(),
        fact: fact('huge', 1),
        intents: [
          intent('a', 'huge'),
          intent('b', 'huge'),
          intent('c', 'huge'),
        ],
        appliedRevision: 1,
        attempt: { kind: 'none' },
        updatedAt: timestamp,
        effectRefs: [],
        workRefs: [],
        presentationRefs: [],
      }),
    ).toThrow(DurabilityCapacityError);

    const tooManyFacts: LegacyTaskIntentState = {
      schema: 'agent-lcars.task-intent-state/v1',
      version: 1,
      tenant: { ...tenant },
      task: { ...task },
      revision: LIFECYCLE_DURABILITY_LIMITS.maxContainerItems + 1,
      activation: { ...activation },
      facts: Array.from(
        { length: LIFECYCLE_DURABILITY_LIMITS.maxContainerItems + 1 },
        (_, index) => {
          const value = fact(`over-${index}`, index + 1);
          const {
            schema: _schema,
            version: _version,
            task: _task,
            ...legacy
          } = value;
          return legacy;
        },
      ),
      intents: [],
      attempt: { kind: 'none' },
      updatedAt: timestamp,
    };
    expect(() => upgradeLegacyTaskIntentState({ state: tooManyFacts })).toThrow(
      DurabilityCapacityError,
    );

    const byteFacts = Array.from(
      { length: LIFECYCLE_DURABILITY_LIMITS.maxContainerItems },
      (_, index) => {
        const value = fact(`bytes-fact-${index}`, index + 1);
        const {
          schema: _schema,
          version: _version,
          task: _task,
          ...legacy
        } = value;
        return legacy;
      },
    );
    const byteSourceFactId = byteFacts[byteFacts.length - 1]?.factId;
    if (byteSourceFactId === undefined) throw new Error('test fixture');
    const byteIntents = Array.from(
      { length: LIFECYCLE_DURABILITY_LIMITS.maxContainerItems },
      (_, index) => {
        const value = intent(`bytes-intent-${index}`, byteSourceFactId);
        const { schema: _schema, version: _version, ...legacy } = value;
        return {
          ...legacy,
          task: { ...legacy.task },
          activation: { ...legacy.activation },
        };
      },
    );
    const overBytes: LegacyTaskIntentState = {
      schema: 'agent-lcars.task-intent-state/v1',
      version: 1,
      tenant: { ...tenant },
      task: { ...task },
      revision: LIFECYCLE_DURABILITY_LIMITS.maxContainerItems,
      activation: { ...activation },
      facts: byteFacts,
      intents: byteIntents,
      attempt: { kind: 'none' },
      updatedAt: timestamp,
    };
    expect(() => upgradeLegacyTaskIntentState({ state: overBytes })).toThrow(
      DurabilityCapacityError,
    );
  });

  it('rejects legacy replay identity, revision, semantic, and source drift', () => {
    const legacyFact = (value: TaskFactHistoryPayload) => {
      const {
        schema: _schema,
        version: _version,
        task: _task,
        ...legacy
      } = value;
      return legacy;
    };
    const legacyIntent = (value: TaskIntentHistoryPayload) => {
      const { schema: _schema, version: _version, ...legacy } = value;
      return {
        ...legacy,
        task: { ...legacy.task },
        activation: { ...legacy.activation },
      };
    };
    const baseState = (
      facts: readonly ReturnType<typeof legacyFact>[],
      intents: readonly ReturnType<typeof legacyIntent>[],
    ): LegacyTaskIntentState => ({
      schema: 'agent-lcars.task-intent-state/v1',
      version: 1,
      tenant: { ...tenant },
      task: { ...task },
      revision: 2,
      activation: { ...activation },
      facts,
      intents,
      attempt: { kind: 'none' },
      updatedAt: timestamp,
    });
    const firstFact = fact('legacy-a', 1);
    const secondFact = fact('legacy-b', 2);
    const firstIntent = intent('legacy-intent', 'legacy-a');
    const duplicateRequest = legacyFact({
      ...secondFact,
      requestId: firstFact.requestId,
    });
    expect(() =>
      upgradeLegacyTaskIntentState({
        state: baseState([legacyFact(firstFact), duplicateRequest], []),
      }),
    ).toThrow();
    expect(() =>
      upgradeLegacyTaskIntentState({
        state: baseState(
          [
            legacyFact(firstFact),
            legacyFact({ ...secondFact, sourceKey: firstFact.sourceKey }),
          ],
          [],
        ),
      }),
    ).toThrow();
    expect(() =>
      upgradeLegacyTaskIntentState({
        state: baseState(
          [
            legacyFact({
              ...firstFact,
              policyDecision: { ...policy('legacy-a'), sourceFactId: 'other' },
            }),
          ],
          [],
        ),
      }),
    ).toThrow();
    expect(() =>
      upgradeLegacyTaskIntentState({
        state: baseState(
          [legacyFact(firstFact)],
          [legacyIntent({ ...firstIntent, revision: 2 })],
        ),
      }),
    ).toThrow();
    expect(() =>
      upgradeLegacyTaskIntentState({
        state: baseState(
          [legacyFact(firstFact)],
          [
            legacyIntent({ ...firstIntent }),
            legacyIntent({
              ...firstIntent,
              intentId: 'different-intent',
              revision: 1,
              semanticKey: firstIntent.semanticKey,
              semanticDigest: 'b'.repeat(64),
            }),
          ],
        ),
      }),
    ).toThrow();
    expect(() =>
      upgradeLegacyTaskIntentState({
        state: baseState(
          [legacyFact(firstFact)],
          [
            legacyIntent({ ...firstIntent }),
            legacyIntent({
              ...firstIntent,
              revision: 2,
              semanticDigest: 'b'.repeat(64),
            }),
          ],
        ),
      }),
    ).toThrow();
    expect(() =>
      upgradeLegacyTaskIntentState({
        state: baseState(
          [legacyFact(firstFact), legacyFact(secondFact)],
          [legacyIntent({ ...firstIntent, sourceFactId: 'missing-fact' })],
        ),
      }),
    ).toThrow();
    expect(() =>
      upgradeLegacyTaskIntentState({
        state: baseState(
          [legacyFact(firstFact)],
          [
            legacyIntent({
              ...firstIntent,
              policyDecision: { ...policy('legacy-a'), ruleId: 'drifted' },
            }),
          ],
        ),
      }),
    ).toThrow();
  });
});
