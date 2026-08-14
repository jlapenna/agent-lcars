import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type {
  IntentCandidate,
  ReduceTaskIntentInput,
  ReduceTaskIntentResult,
  TaskIntentState,
} from './task-intent-reducer';
import {
  compareIntentOrdering,
  reduceTaskIntent,
  taskIntentInputDigest,
} from './task-intent-reducer';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const timestamp = '2026-08-14T12:00:00.000Z';
const tenant = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
};
const task = { tenantId: 'tenant-1', repositoryId: 123, issueNumber: 9 };

const activation: ActivationRecord = {
  schema: 'agent-lcars.control-plane-activation/v1',
  version: 1,
  tenant,
  taskClassId: 'github-issue',
  activationId: 'activation-1',
  authorityEpoch: 1,
  effectiveBoundary: 1,
  mode: 'central-authoritative',
  effectMode: 'enabled',
  recordedAt: timestamp,
};

function envelope(
  factId: string,
  options: {
    requestId?: string;
    deliveryId?: string;
    signal?: ControlPlaneSignalEnvelope['signal'];
  } = {},
): ControlPlaneSignalEnvelope {
  return {
    schema: 'agent-lcars.control-plane-signal/v1',
    version: 1,
    requestId: options.requestId ?? `request-${factId}`,
    factId,
    tenant,
    task,
    signal:
      options.signal ??
      ({
        kind: 'requested-work',
        mode: 'implement',
        requestKey: `request-${factId}`,
      } as const),
    receivedAt: timestamp,
    source: {
      kind: 'github-webhook',
      deliveryId: options.deliveryId ?? `delivery-${factId}`,
      repositoryId: tenant.repositoryId,
      installationId: tenant.installationId,
      bodySha256: shaA,
      event: 'issues',
      action: 'labeled',
      actorId: 789,
      actorLogin: 'octocat',
      occurredAt: timestamp,
      hmacKeyVersion: 'key-v1',
    },
  };
}

function policy(
  factId: string,
  decision: PolicyDecision['decision'] = 'accepted',
): PolicyDecision {
  return {
    schema: 'agent-lcars.policy-decision/v1',
    version: 1,
    policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: shaA },
    decision,
    ruleId: 'maintainer',
    sourceFactId: factId,
    principal: { kind: 'github-actor', actorId: 789, login: 'octocat' },
    evidenceRef: `evidence-${factId}`,
    decidedAt: timestamp,
  };
}

function candidate(
  intentId: string,
  occurredAt = timestamp,
  tieBreaker = intentId,
  semanticDigest = shaA,
): IntentCandidate {
  return {
    intentId,
    semanticKey: `semantic-${intentId}`,
    semanticDigest,
    orderingKey: { occurredAt, tieBreaker },
  };
}

function input(
  factId: string,
  options: Partial<ReduceTaskIntentInput> = {},
): ReduceTaskIntentInput {
  const command: ReduceTaskIntentInput = {
    expectedRevision: 0,
    transitionedAt: timestamp,
    canonicalDigest: '',
    envelope: envelope(factId),
    policyDecision: policy(factId),
    activation,
    candidate: candidate(`intent-${factId}`),
    ...options,
  };
  if (options.canonicalDigest === undefined) {
    command.canonicalDigest = taskIntentInputDigest(command);
  }
  return command;
}

function signed(command: ReduceTaskIntentInput): ReduceTaskIntentInput {
  return { ...command, canonicalDigest: taskIntentInputDigest(command) };
}

function operatorRetryEnvelope(
  factId: string,
  commandId: string,
): ControlPlaneSignalEnvelope {
  return {
    schema: 'agent-lcars.control-plane-signal/v1',
    version: 1,
    requestId: `request-${factId}`,
    factId,
    tenant,
    task,
    signal: {
      kind: 'requested-work',
      mode: 'implement',
      requestKey: commandId,
    },
    receivedAt: timestamp,
    source: {
      kind: 'operator-command',
      operatorId: 'operator-1',
      commandId,
      command: 'retry',
    },
  };
}

function operatorPolicy(factId: string): PolicyDecision {
  return {
    ...policy(factId),
    principal: { kind: 'operator', operatorId: 'operator-1' },
  };
}

function applied(result: ReduceTaskIntentResult) {
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error('Expected applied result');
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('Task/Intent reducer', () => {
  it('admits one desired intent without mutating its frozen input', () => {
    const command = deepFreeze(input('fact-1'));
    const result = applied(reduceTaskIntent(undefined, command));

    expect(result.state.revision).toBe(1);
    expect(result.state.desired).toMatchObject({
      intentId: 'intent-fact-1',
      intentRevision: 1,
    });
    expect(result.state.attempt).toEqual({
      kind: 'unlaunched',
      intentId: 'intent-fact-1',
    });
    expect(result.effects.map((effect) => effect.kind)).toEqual([
      'admit-attempt',
    ]);
    expect(result.state.intents).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
    expect(reduceTaskIntent(undefined, command)).toEqual(result);
  });

  it('replays before CAS without revising state or re-emitting effects', () => {
    const firstCommand = input('fact-1');
    const first = applied(reduceTaskIntent(undefined, firstCommand));
    const second = applied(
      reduceTaskIntent(
        first.state,
        input('fact-2', {
          expectedRevision: 1,
          candidate: candidate('intent-2', '2026-08-14T12:01:00.000Z'),
        }),
      ),
    );

    const replay = reduceTaskIntent(second.state, firstCommand);
    expect(replay.status).toBe('replay');
    expect(replay.state).toBe(second.state);
    expect(replay.effects).toEqual([]);
    expect(replay.resolution).toEqual(first.resolution);
  });

  it('conflicts when fact, request, or authenticated source keys change digest', () => {
    const first = applied(reduceTaskIntent(undefined, input('fact-1')));
    for (const changed of [
      input('fact-1', {
        expectedRevision: 1,
        candidate: candidate('changed-intent'),
      }),
      input('fact-2', {
        expectedRevision: 1,
        envelope: envelope('fact-2', { requestId: 'request-fact-1' }),
      }),
      input('fact-3', {
        expectedRevision: 1,
        envelope: envelope('fact-3', { deliveryId: 'delivery-fact-1' }),
      }),
    ]) {
      const result = reduceTaskIntent(first.state, changed);
      expect(result).toMatchObject({
        status: 'conflict',
        conflict: 'digest-conflict',
        state: first.state,
      });
    }

    const changedPayloadWithReusedDigest = input('fact-1', {
      expectedRevision: 1,
      candidate: candidate('changed-again'),
      canonicalDigest: first.state.facts[0]?.canonicalDigest,
    });
    expect(
      reduceTaskIntent(first.state, changedPayloadWithReusedDigest),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });
  });

  it('records a same-digest semantic duplicate and rejects semantic drift', () => {
    const originalCandidate = candidate('intent-1');
    const first = applied(
      reduceTaskIntent(
        undefined,
        input('fact-1', { candidate: originalCandidate }),
      ),
    );
    const duplicate = applied(
      reduceTaskIntent(
        first.state,
        input('fact-2', {
          expectedRevision: 1,
          candidate: { ...originalCandidate, intentId: 'ignored-new-id' },
        }),
      ),
    );
    expect(duplicate.resolution).toMatchObject({
      kind: 'semantic-duplicate',
      intentId: 'intent-1',
    });
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.state.revision).toBe(2);
    expect(duplicate.state.intents).toHaveLength(1);

    const drift = reduceTaskIntent(
      duplicate.state,
      input('fact-3', {
        expectedRevision: 2,
        candidate: {
          ...originalCandidate,
          intentId: 'other-id',
          semanticDigest: shaB,
        },
      }),
    );
    expect(drift).toMatchObject({
      status: 'conflict',
      conflict: 'semantic-conflict',
    });

    const reusedIntentId = reduceTaskIntent(
      duplicate.state,
      input('fact-4', {
        expectedRevision: 2,
        candidate: candidate('intent-1', timestamp, 'intent-1', shaB),
      }),
    );
    expect(reusedIntentId).toMatchObject({
      status: 'conflict',
      conflict: 'semantic-conflict',
    });
  });

  it('requires current revision for every new fact', () => {
    const first = applied(reduceTaskIntent(undefined, input('fact-1')));
    const stale = reduceTaskIntent(first.state, input('fact-2'));
    expect(stale).toMatchObject({
      status: 'conflict',
      conflict: 'revision-conflict',
      state: first.state,
    });
  });

  it('uses stable event ordering rather than arrival order', () => {
    const older = candidate('older', '2026-08-14T11:59:00.000Z', 'a');
    const newer = candidate('newer', timestamp, 'b');
    const newerFirst = applied(
      reduceTaskIntent(undefined, input('fact-new', { candidate: newer })),
    );
    const lateOlder = applied(
      reduceTaskIntent(
        newerFirst.state,
        input('fact-old', { expectedRevision: 1, candidate: older }),
      ),
    );
    expect(lateOlder.resolution.kind).toBe('stale');
    expect(lateOlder.state.desired?.intentId).toBe('newer');
    expect(lateOlder.effects).toEqual([]);

    const olderFirst = applied(
      reduceTaskIntent(undefined, input('fact-old', { candidate: older })),
    );
    const laterNewer = applied(
      reduceTaskIntent(
        olderFirst.state,
        input('fact-new', { expectedRevision: 1, candidate: newer }),
      ),
    );
    expect(laterNewer.state.desired?.intentId).toBe('newer');
    expect(
      laterNewer.state.intents.filter((intent) => intent.intentId === 'older'),
    ).toHaveLength(2);

    const tiedA = candidate('a', timestamp, 'same');
    const tiedB = candidate('b', timestamp, 'same');
    const tiedAFirst = applied(
      reduceTaskIntent(undefined, input('fact-tie-a', { candidate: tiedA })),
    );
    const tiedBSecond = applied(
      reduceTaskIntent(
        tiedAFirst.state,
        input('fact-tie-b', { expectedRevision: 1, candidate: tiedB }),
      ),
    );
    const tiedBFirst = applied(
      reduceTaskIntent(undefined, input('fact-tie-b', { candidate: tiedB })),
    );
    const tiedASecond = applied(
      reduceTaskIntent(
        tiedBFirst.state,
        input('fact-tie-a', { expectedRevision: 1, candidate: tiedA }),
      ),
    );
    expect(tiedBSecond.state.desired?.intentId).toBe('b');
    expect(tiedASecond.state.desired?.intentId).toBe('b');

    const wholeSecond = candidate('whole-second', '2026-08-14T12:00:00Z', 'z');
    const fractionalLater = candidate(
      'fractional-later',
      '2026-08-14T12:00:00.1Z',
      'a',
    );
    expect(
      compareIntentOrdering(
        fractionalLater.orderingKey,
        wholeSecond.orderingKey,
      ),
    ).toBeGreaterThan(0);
  });

  it('rejects timestamps outside the strict UTC wire contract', () => {
    expect(
      reduceTaskIntent(
        undefined,
        input('fact-invalid-time', { transitionedAt: '2026Z' }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });
    expect(
      reduceTaskIntent(
        undefined,
        input('fact-impossible-time', {
          transitionedAt: '2026-02-30T12:00:00Z',
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });
  });

  it('supersedes unlaunched work but drains launched work only once', () => {
    const first = applied(reduceTaskIntent(undefined, input('fact-1')));
    const replacement = applied(
      reduceTaskIntent(
        first.state,
        input('fact-2', {
          expectedRevision: 1,
          candidate: candidate('intent-2', '2026-08-14T12:01:00.000Z'),
        }),
      ),
    );
    expect(replacement.effects.map((effect) => effect.kind)).toEqual([
      'admit-attempt',
    ]);
    expect(replacement.state.attempt).toEqual({
      kind: 'unlaunched',
      intentId: 'intent-2',
    });

    const launched: TaskIntentState = {
      ...first.state,
      attempt: {
        kind: 'launched',
        intentId: 'intent-fact-1',
        staleForDesiredState: false,
        cancellationRequested: false,
      },
    };
    const whileLaunched = applied(
      reduceTaskIntent(
        launched,
        input('fact-3', {
          expectedRevision: 1,
          candidate: candidate('intent-3', '2026-08-14T12:02:00.000Z'),
        }),
      ),
    );
    expect(whileLaunched.effects.map((effect) => effect.kind)).toEqual([
      'cancel-or-drain',
    ]);
    expect(whileLaunched.state.attempt).toMatchObject({
      kind: 'launched',
      staleForDesiredState: true,
      cancellationRequested: true,
      supersededByIntentId: 'intent-3',
    });

    const newerAgain = applied(
      reduceTaskIntent(
        whileLaunched.state,
        input('fact-4', {
          expectedRevision: 2,
          candidate: candidate('intent-4', '2026-08-14T12:03:00.000Z'),
        }),
      ),
    );
    expect(newerAgain.effects).toEqual([]);
    expect(newerAgain.state.attempt).toMatchObject({
      supersededByIntentId: 'intent-4',
    });
  });

  it('records rejected work as parked and makes shadow mode effect-free', () => {
    const rejected = applied(
      reduceTaskIntent(
        undefined,
        input('fact-1', { policyDecision: policy('fact-1', 'rejected') }),
      ),
    );
    expect(rejected.resolution.kind).toBe('parked');
    expect(rejected.state.desired).toBeUndefined();
    expect(rejected.state.intents[0]?.status).toBe('parked');
    expect(rejected.effects.map((effect) => effect.kind)).toEqual([
      'park-projection',
    ]);

    const shadowActivation: ActivationRecord = {
      ...activation,
      mode: 'shadow',
      effectMode: 'none',
    };
    const shadow = applied(
      reduceTaskIntent(
        undefined,
        input('fact-2', { activation: shadowActivation }),
      ),
    );
    expect(shadow.state.desired?.intentId).toBe('intent-fact-2');
    expect(shadow.effects).toEqual([]);
  });

  it('creates a new desired intent for an authorized retry after park', () => {
    const originalCandidate = candidate('intent-1');
    const first = applied(
      reduceTaskIntent(
        undefined,
        input('fact-1', { candidate: originalCandidate }),
      ),
    );
    const parked = applied(
      reduceTaskIntent(
        first.state,
        input('fact-park', {
          expectedRevision: 1,
          envelope: envelope('fact-park', {
            signal: { kind: 'park', commandKey: 'park-1' },
          }),
          policyDecision: policy('fact-park'),
          candidate: undefined,
        }),
      ),
    );
    const retryCandidate = {
      ...candidate('intent-2', '2026-08-14T12:01:00.000Z'),
      semanticKey: originalCandidate.semanticKey,
      semanticDigest: originalCandidate.semanticDigest,
    };
    const retried = applied(
      reduceTaskIntent(
        parked.state,
        input('fact-retry', {
          expectedRevision: 2,
          envelope: operatorRetryEnvelope('fact-retry', 'retry-1'),
          policyDecision: operatorPolicy('fact-retry'),
          candidate: retryCandidate,
        }),
      ),
    );
    expect(retried.resolution).toMatchObject({
      kind: 'desired',
      intentId: 'intent-2',
    });
    expect(retried.state.desired?.intentId).toBe('intent-2');
    expect(retried.effects.map((effect) => effect.kind)).toEqual([
      'admit-attempt',
    ]);
    expect(
      retried.state.intents.filter(
        (intent) => intent.semanticKey === originalCandidate.semanticKey,
      ),
    ).toHaveLength(3);

    const duplicate = applied(
      reduceTaskIntent(
        retried.state,
        input('fact-retry-duplicate', {
          expectedRevision: 3,
          candidate: { ...retryCandidate, intentId: 'ignored-duplicate-id' },
        }),
      ),
    );
    expect(duplicate.resolution).toMatchObject({
      kind: 'semantic-duplicate',
      intentId: 'intent-2',
    });
  });

  it('parks or cancels desired work without terminalizing launched truth', () => {
    const first = applied(reduceTaskIntent(undefined, input('fact-1')));
    const parkEnvelope = envelope('fact-2', {
      signal: { kind: 'park', commandKey: 'park-1' },
    });
    const parked = applied(
      reduceTaskIntent(
        first.state,
        signed({
          ...input('fact-2'),
          expectedRevision: 1,
          envelope: parkEnvelope,
          policyDecision: policy('fact-2'),
          candidate: undefined,
        }),
      ),
    );
    expect(parked.state.desired).toBeUndefined();
    expect(parked.state.attempt).toEqual({ kind: 'none' });
    expect(parked.effects.map((effect) => effect.kind)).toEqual([
      'cancel-unlaunched',
      'park-projection',
    ]);

    const launched: TaskIntentState = {
      ...first.state,
      attempt: {
        kind: 'launched',
        intentId: 'intent-fact-1',
        staleForDesiredState: false,
        cancellationRequested: false,
      },
    };
    const cancelEnvelope = envelope('fact-3', {
      signal: { kind: 'cancel', commandKey: 'cancel-1' },
    });
    const cancelled = applied(
      reduceTaskIntent(
        launched,
        signed({
          ...input('fact-3'),
          expectedRevision: 1,
          envelope: cancelEnvelope,
          policyDecision: policy('fact-3'),
          candidate: undefined,
        }),
      ),
    );
    expect(cancelled.state.attempt).toMatchObject({
      kind: 'launched',
      cancellationRequested: true,
    });
    expect(cancelled.effects.map((effect) => effect.kind)).toEqual([
      'cancel-or-drain',
    ]);
  });

  it('rejects policy, activation, task, and closed-shape mismatches', () => {
    expect(
      reduceTaskIntent(undefined, {
        ...signed({
          ...input('fact-1'),
          policyDecision: policy('other-fact'),
        }),
      }),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });
    expect(
      reduceTaskIntent(
        undefined,
        signed({
          ...input('fact-1'),
          policyDecision: {
            ...policy('fact-1'),
            principal: { kind: 'github-actor', actorId: 999, login: 'other' },
          },
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });
    expect(
      reduceTaskIntent(
        undefined,
        signed({
          ...input('fact-1'),
          activation: { ...activation, mode: 'retired', effectMode: 'none' },
        }),
      ),
    ).toMatchObject({
      status: 'conflict',
      conflict: 'activation-mismatch',
    });
    expect(
      reduceTaskIntent(undefined, {
        ...input('fact-1'),
        canonicalDigest: 'not-a-digest',
      }),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });

    const first = applied(reduceTaskIntent(undefined, input('fact-1')));
    expect(
      reduceTaskIntent(
        first.state,
        signed({
          ...input('fact-2', { expectedRevision: 1 }),
          activation: { ...activation, authorityEpoch: 2 },
        }),
      ),
    ).toMatchObject({
      status: 'conflict',
      conflict: 'activation-mismatch',
      state: first.state,
    });
    expect(
      reduceTaskIntent(
        first.state,
        signed({
          ...input('fact-2', { expectedRevision: 1 }),
          envelope: {
            ...envelope('fact-2'),
            task: { ...task, issueNumber: 10 },
          },
        }),
      ),
    ).toMatchObject({
      status: 'conflict',
      conflict: 'task-mismatch',
      state: first.state,
    });
  });
});
