import type {
  AcceptedAttemptSpec,
  AgentResultClaimV1,
  AttemptOutcome,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type {
  AttemptEvent,
  AttemptState,
  ReduceAttemptInput,
} from './attempt-reducer';
import {
  attemptSpecDigest,
  attemptTransitionDigest,
  deriveFinalizedOutcome,
  reduceAttempt,
} from './attempt-reducer';

const timestamp = '2026-08-15T12:00:00.000Z';
const later = '2026-08-15T12:05:00.000Z';
const deadline = '2026-08-15T12:10:00.000Z';
const validationTime = '2026-08-15T12:11:00.000Z';
const finalTime = '2026-08-15T12:12:00.000Z';
const sha = 'a'.repeat(64);
const attemptId = 'A'.repeat(22);
const tenant = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
};
const task = { tenantId: 'tenant-1', repositoryId: 123, issueNumber: 9 };
const binding = {
  runId: 10,
  runAttempt: 1,
  checkRunId: 11,
  workflowPath: '.github/workflows/worker.yml',
  workflowRef: 'refs/heads/main',
  workflowSha: 'c'.repeat(40),
};

const spec: AcceptedAttemptSpec = {
  schema: 'agent-lcars.attempt-spec/v1',
  version: 1,
  requestId: 'request-1',
  attemptId,
  tenant,
  task,
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
    workflowPath: '.github/workflows/worker.yml',
    workflowRef: 'refs/heads/main',
    workflowSha: 'c'.repeat(40),
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
    decidedAt: timestamp,
  },
};

function register(): ReduceAttemptInput {
  return {
    kind: 'register',
    expectedRevision: 0,
    transitionedAt: timestamp,
    spec,
    specDigest: attemptSpecDigest(spec),
  };
}

function transition(
  state: AttemptState,
  event: AttemptEvent,
  at = later,
): ReduceAttemptInput {
  return {
    kind: 'transition',
    expectedRevision: state.revision,
    transitionedAt: at,
    canonicalDigest: attemptTransitionDigest(event),
    event,
  };
}

function applied<T extends { status: string }>(
  value: T,
): Extract<T, { status: 'applied' }> {
  expect(value.status).toBe('applied');
  return value as Extract<T, { status: 'applied' }>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const failure = {
  owningSystem: 'finalizer' as const,
  phase: 'validation' as const,
  reason: 'deliverable_absent' as const,
  retryDisposition: 'manual' as const,
  evidenceRef: 'failure-evidence-1',
};

function failedNoDeliverable(
  terminalFactId: string,
  validationFactId: string,
  finalizedAt = finalTime,
): AttemptOutcome {
  return {
    schema: 'agent-lcars.attempt-outcome/v1',
    version: 1,
    attemptId,
    terminalState: 'failed',
    execution: 'exited',
    result: 'none',
    failure,
    evidence: { kind: 'no-deliverable', terminalFactId },
    evidenceValidation: {
      status: 'absent',
      validationFactId,
      validatedAt: finalizedAt,
    },
    finalizedAt,
  };
}

function successfulPullRequest(
  claim: AgentResultClaimV1,
  validationFactId: string,
  finalizedAt = finalTime,
): AttemptOutcome {
  if (claim.kind !== 'pull-request') throw new Error('Expected PR claim');
  return {
    schema: 'agent-lcars.attempt-outcome/v1',
    version: 1,
    attemptId,
    terminalState: 'succeeded',
    execution: 'exited',
    result: 'pull-request',
    reference: { kind: 'pull-request', number: claim.number },
    evidence: { kind: 'validated-claim', validationFactId, claim },
    evidenceValidation: {
      status: 'validated',
      validationFactId,
      validatedAt: validationTime,
    },
    finalizedAt,
  };
}

function lifecycleOutcome(
  terminalState: 'cancelled' | 'superseded' | 'lost',
  decisionFactId: string,
  finalizedAt = finalTime,
): AttemptOutcome {
  return {
    schema: 'agent-lcars.attempt-outcome/v1',
    version: 1,
    attemptId,
    terminalState,
    execution: terminalState === 'lost' ? 'lost' : 'cancelled',
    result: 'none',
    evidence: { kind: 'lifecycle-decision', decisionFactId },
    evidenceValidation: { status: 'not-applicable' },
    finalizedAt,
  };
}

function launchRejectedOutcome(eventId: string): AttemptOutcome {
  return {
    schema: 'agent-lcars.attempt-outcome/v1',
    version: 1,
    attemptId,
    terminalState: 'failed',
    execution: 'not_started',
    result: 'startup-failure',
    failure: {
      owningSystem: 'controller',
      phase: 'launch',
      reason: 'launch_rejected',
      retryDisposition: 'never',
      evidenceRef: 'launch-rejection-1',
    },
    evidence: { kind: 'lifecycle-decision', decisionFactId: eventId },
    evidenceValidation: { status: 'not-applicable' },
    finalizedAt: later,
  };
}

async function observation(
  factId: string,
  payload: RuntimeObservationEnvelope['payload'],
  extras: Partial<RuntimeObservationEnvelope> = {},
): Promise<AttemptEvent> {
  const envelope: RuntimeObservationEnvelope = {
    schema: 'agent-lcars.runtime-observation/v1',
    version: 1,
    requestId: `request-${factId}`,
    factId,
    attemptId,
    tenant,
    task,
    source: { kind: 'github-provider', sourceId: 'github-1' },
    observedAt: later,
    payloadSha256: await runtimeObservationPayloadSha256(payload),
    payload,
    ...extras,
  };
  return {
    kind: 'observation',
    envelope,
    ...(payload.kind === 'run-terminal'
      ? { finalizationDeadline: deadline }
      : {}),
  };
}

async function activeAttempt(): Promise<AttemptState> {
  const registered = applied(reduceAttempt(undefined, register())).state;
  const accepted = applied(
    reduceAttempt(
      registered,
      transition(registered, { kind: 'launch-accepted', eventId: 'accepted' }),
    ),
  ).state;
  const bound = await observation('bound-1', { kind: 'run-bound', binding });
  return applied(reduceAttempt(accepted, transition(accepted, bound))).state;
}

async function resultObserved(
  conclusion:
    'success' | 'failure' | 'cancelled' | 'timed_out' | 'skipped' = 'success',
): Promise<AttemptState> {
  const active = await activeAttempt();
  const terminal = await observation('terminal-1', {
    kind: 'run-terminal',
    binding,
    conclusion,
    observedAt: later,
  });
  return applied(reduceAttempt(active, transition(active, terminal))).state;
}

describe('Attempt reducer', () => {
  it('records the only launch operation atomically before its dispatch directive', () => {
    const command = deepFreeze(register());
    const first = applied(reduceAttempt(undefined, command));
    expect(first.state).toMatchObject({
      phase: 'launch-pending',
      launch: { operationId: attemptId, state: 'recorded' },
    });
    expect(first.effects).toEqual([
      {
        kind: 'dispatch-launch',
        effectKey: `${attemptId}:launch:1`,
        attemptId,
        operationId: attemptId,
        executionEpoch: 1,
      },
    ]);
    expect(JSON.parse(JSON.stringify(first.state))).toEqual(first.state);
    expect(reduceAttempt(undefined, command)).toEqual(first);
    expect(reduceAttempt(first.state, register()).status).toBe('replay');
    expect(
      applied(
        reduceAttempt(
          first.state,
          transition(first.state, {
            kind: 'launch-response-unknown',
            eventId: 'launch-unknown',
          }),
        ),
      ).state.phase,
    ).toBe('launch-response-unknown');
  });

  it('binds one exact spec-matching run, replays its fact, and quarantines another', async () => {
    const registered = applied(reduceAttempt(undefined, register())).state;
    const accepted = applied(
      reduceAttempt(
        registered,
        transition(registered, {
          kind: 'launch-accepted',
          eventId: 'accepted',
        }),
      ),
    ).state;
    const boundEvent = await observation('bound-1', {
      kind: 'run-bound',
      binding,
    });
    const bound = applied(
      reduceAttempt(accepted, transition(accepted, boundEvent)),
    ).state;
    expect(bound.phase).toBe('active');
    expect(reduceAttempt(bound, transition(bound, boundEvent)).status).toBe(
      'replay',
    );
    const wrong = await observation('bound-2', {
      kind: 'run-bound',
      binding: { ...binding, runId: 99 },
    });
    expect(reduceAttempt(bound, transition(bound, wrong))).toMatchObject({
      status: 'conflict',
      conflict: 'binding-conflict',
    });
  });

  it('holds an out-of-order terminal and claim until its exact binding arrives', async () => {
    const registered = applied(reduceAttempt(undefined, register())).state;
    const terminal = await observation('terminal-1', {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: later,
    });
    const pending = applied(
      reduceAttempt(registered, transition(registered, terminal)),
    ).state;
    const claim = await observation('claim-1', {
      kind: 'agent-result-claim',
      claim: {
        kind: 'pull-request',
        number: 12,
        localAttemptMarker: 'g1:intent-1',
      },
    });
    const claimed = applied(
      reduceAttempt(pending, transition(pending, claim)),
    ).state;
    expect(claimed.pendingTerminal?.factId).toBe('terminal-1');
    const bound = await observation('bound-1', { kind: 'run-bound', binding });
    const opened = applied(
      reduceAttempt(claimed, transition(claimed, bound)),
    ).state;
    expect(opened.finalization?.evidence).toHaveLength(1);
    expect(opened.phase).toBe('result-observed');
  });

  it('recomputes payload digests and denies future grants only once on cancellation', async () => {
    const first = applied(reduceAttempt(undefined, register())).state;
    const bad = await observation('bound-1', { kind: 'run-bound', binding });
    if (bad.kind === 'observation') bad.envelope.payloadSha256 = 'b'.repeat(64);
    expect(reduceAttempt(first, transition(first, bad))).toMatchObject({
      status: 'conflict',
      conflict: 'invalid-input',
    });
    const cancelling = applied(
      reduceAttempt(
        first,
        transition(first, { kind: 'request-cancel', eventId: 'cancel-1' }),
      ),
    ).state;
    const again = applied(
      reduceAttempt(
        cancelling,
        transition(cancelling, { kind: 'request-cancel', eventId: 'cancel-2' }),
      ),
    );
    expect(
      again.effects.filter((effect) => effect.kind === 'deny-future-grants'),
    ).toHaveLength(0);
    expect(
      again.effects.filter((effect) => effect.kind === 'cancel-or-drain'),
    ).toHaveLength(0);
  });

  it('binds registration replay to revision and the canonical immutable spec', () => {
    const first = applied(reduceAttempt(undefined, register())).state;
    expect(
      reduceAttempt(first, {
        ...register(),
        expectedRevision: 99,
      } as unknown as ReduceAttemptInput),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });

    const changedSpec = { ...spec, requestId: 'request-2' };
    expect(
      reduceAttempt(first, {
        ...register(),
        spec: changedSpec,
        specDigest: attemptSpecDigest(changedSpec),
      }),
    ).toMatchObject({ status: 'conflict', conflict: 'spec-conflict' });
  });

  it('records unknown launch recovery once and never redispatches', () => {
    const registered = applied(reduceAttempt(undefined, register())).state;
    const event: AttemptEvent = {
      kind: 'launch-response-unknown',
      eventId: 'launch-unknown',
    };
    const command = transition(registered, event);
    const unknown = applied(reduceAttempt(registered, command));
    expect(unknown.effects.map((effect) => effect.kind)).toEqual([
      'discover-exact-run',
    ]);
    expect(reduceAttempt(unknown.state, command)).toMatchObject({
      status: 'replay',
      effects: [],
    });
    expect(
      reduceAttempt(
        unknown.state,
        transition(unknown.state, {
          kind: 'launch-accepted',
          eventId: 'launch-unknown',
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'digest-conflict' });

    expect(
      reduceAttempt(
        unknown.state,
        transition(unknown.state, {
          kind: 'mark-lost',
          eventId: 'lost-unknown-not-started',
          outcome: {
            ...lifecycleOutcome('lost', 'lost-unknown-not-started', later),
            execution: 'not_started',
          },
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });
    const lost = applied(
      reduceAttempt(
        unknown.state,
        transition(unknown.state, {
          kind: 'mark-lost',
          eventId: 'lost-unknown',
          outcome: lifecycleOutcome('lost', 'lost-unknown', later),
        }),
      ),
    );
    expect(lost.state.outcome?.execution).toBe('lost');
  });

  it('binds replay identity to the complete observation envelope', async () => {
    const active = await activeAttempt();
    const first = await observation('heartbeat-1', {
      kind: 'heartbeat',
      grantId: 'grant-1',
      at: later,
      phase: 'agent-execution',
    });
    const recorded = applied(reduceAttempt(active, transition(active, first)));
    const changed = await observation(
      'heartbeat-2',
      {
        kind: 'heartbeat',
        grantId: 'grant-1',
        at: later,
        phase: 'agent-execution',
      },
      {
        requestId: 'request-heartbeat-1',
        source: { kind: 'github-provider', sourceId: 'github-2' },
      },
    );
    expect(
      reduceAttempt(recorded.state, transition(recorded.state, changed)),
    ).toMatchObject({ status: 'conflict', conflict: 'digest-conflict' });
  });

  it('freezes the first exact terminal execution fact before and after binding', async () => {
    const registered = applied(reduceAttempt(undefined, register())).state;
    const firstTerminal = await observation('terminal-1', {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: later,
    });
    const pending = applied(
      reduceAttempt(registered, transition(registered, firstTerminal)),
    ).state;
    const conflictingPending = await observation('terminal-2', {
      kind: 'run-terminal',
      binding,
      conclusion: 'failure',
      observedAt: later,
    });
    expect(
      reduceAttempt(pending, transition(pending, conflictingPending)),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-transition' });
    expect(pending.pendingTerminal?.factId).toBe('terminal-1');

    const observed = await resultObserved();
    const conflictingBound = await observation('terminal-2', {
      kind: 'run-terminal',
      binding,
      conclusion: 'failure',
      observedAt: later,
    });
    expect(
      reduceAttempt(observed, transition(observed, conflictingBound)),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-transition' });
    expect(observed.finalization?.terminalFactId).toBe('terminal-1');
  });

  it('enforces the finalization window before accepting claims or validations', async () => {
    const observed = await resultObserved();
    const lateClaim = await observation(
      'claim-late',
      {
        kind: 'agent-result-claim',
        claim: {
          kind: 'pull-request',
          number: 12,
          localAttemptMarker: 'g1:intent-1',
        },
      },
      { observedAt: validationTime },
    );
    expect(
      reduceAttempt(observed, transition(observed, lateClaim)),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-transition' });

    const earlyStart: AttemptEvent = {
      kind: 'start-validation',
      eventId: 'start-early',
      at: later,
    };
    expect(
      reduceAttempt(observed, transition(observed, earlyStart)),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-transition' });

    const started = applied(
      reduceAttempt(
        observed,
        transition(
          observed,
          { kind: 'start-validation', eventId: 'start-1', at: deadline },
          deadline,
        ),
      ),
    ).state;
    const claimAfterStart = await observation('claim-after-start', {
      kind: 'agent-result-claim',
      claim: {
        kind: 'comment',
        commentId: 'comment-1',
        localAttemptMarker: 'g1:intent-1',
      },
    });
    expect(
      reduceAttempt(started, transition(started, claimAfterStart)),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-transition' });
  });

  it('requires validation to start and binds each validation fact to its claim', async () => {
    const observed = await resultObserved();
    const claim = await observation('claim-1', {
      kind: 'agent-result-claim',
      claim: {
        kind: 'pull-request',
        number: 12,
        localAttemptMarker: 'g1:intent-1',
      },
    });
    const claimed = applied(
      reduceAttempt(observed, transition(observed, claim)),
    ).state;
    const validation: AttemptEvent = {
      kind: 'validate-claim',
      eventId: 'validation-1',
      claimFactId: 'claim-1',
      validation: {
        status: 'validated',
        validationFactId: 'validation-1',
        validatedAt: validationTime,
      },
    };
    expect(
      reduceAttempt(claimed, transition(claimed, validation)),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-transition' });

    const started = applied(
      reduceAttempt(
        claimed,
        transition(
          claimed,
          { kind: 'start-validation', eventId: 'start-1', at: deadline },
          deadline,
        ),
      ),
    );
    expect(started.effects.map((effect) => effect.kind)).toEqual([
      'validate-evidence',
    ]);
    expect(
      reduceAttempt(
        started.state,
        transition(started.state, {
          ...validation,
          eventId: 'validation-other',
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });
  });

  it('finalizes exactly one independently validated claim and rejects forged proof', async () => {
    const observed = await resultObserved();
    const claimValue: AgentResultClaimV1 = {
      kind: 'pull-request',
      number: 12,
      localAttemptMarker: 'g1:intent-1',
    };
    const claim = await observation('claim-1', {
      kind: 'agent-result-claim',
      claim: claimValue,
    });
    const claimed = applied(
      reduceAttempt(observed, transition(observed, claim)),
    ).state;
    const started = applied(
      reduceAttempt(
        claimed,
        transition(
          claimed,
          { kind: 'start-validation', eventId: 'start-1', at: deadline },
          deadline,
        ),
      ),
    ).state;
    const validated = applied(
      reduceAttempt(
        started,
        transition(
          started,
          {
            kind: 'validate-claim',
            eventId: 'validation-1',
            claimFactId: 'claim-1',
            validation: {
              status: 'validated',
              validationFactId: 'validation-1',
              validatedAt: validationTime,
            },
          },
          validationTime,
        ),
      ),
    ).state;

    const forged = successfulPullRequest(
      { ...claimValue, number: 13 },
      'validation-1',
    );
    expect(
      reduceAttempt(
        validated,
        transition(
          validated,
          { kind: 'finalize', eventId: 'finalize-success', outcome: forged },
          finalTime,
        ),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });

    const finalizedEvent: AttemptEvent = {
      kind: 'finalize',
      eventId: 'finalize-success',
      outcome: successfulPullRequest(claimValue, 'validation-1'),
    };
    const finalizeCommand = transition(validated, finalizedEvent, finalTime);
    const finalized = applied(reduceAttempt(validated, finalizeCommand));
    expect(finalized.state.phase).toBe('terminal');
    expect(finalized.state.outcome?.terminalState).toBe('succeeded');
    expect(reduceAttempt(finalized.state, finalizeCommand)).toMatchObject({
      status: 'replay',
      effects: [],
    });
  });

  it('finalizes zero valid claims as exact no-deliverable evidence', async () => {
    const observed = await resultObserved();
    const validating = applied(
      reduceAttempt(
        observed,
        transition(
          observed,
          { kind: 'start-validation', eventId: 'start-zero', at: deadline },
          deadline,
        ),
      ),
    );
    expect(validating.effects).toEqual([]);
    const outcome = failedNoDeliverable('terminal-1', 'finalize-zero');
    const finalized = applied(
      reduceAttempt(
        validating.state,
        transition(
          validating.state,
          { kind: 'finalize', eventId: 'finalize-zero', outcome },
          finalTime,
        ),
      ),
    );
    expect(finalized.state.outcome).toEqual(outcome);
  });

  it('lets immutable terminal truth dominate validated claims', async () => {
    const observed = await resultObserved('failure');
    const claim = await observation('failure-claim', {
      kind: 'agent-result-claim',
      claim: {
        kind: 'pull-request',
        number: 12,
        localAttemptMarker: 'g1:intent-1',
      },
    });
    const claimed = applied(
      reduceAttempt(observed, transition(observed, claim)),
    ).state;
    const validating = applied(
      reduceAttempt(
        claimed,
        transition(
          claimed,
          { kind: 'start-validation', eventId: 'failure-start', at: deadline },
          deadline,
        ),
      ),
    ).state;
    const validated = applied(
      reduceAttempt(
        validating,
        transition(
          validating,
          {
            kind: 'validate-claim',
            eventId: 'failure-validation',
            claimFactId: 'failure-claim',
            validation: {
              status: 'validated',
              validationFactId: 'failure-validation',
              validatedAt: validationTime,
            },
          },
          validationTime,
        ),
      ),
    ).state;

    expect(
      deriveFinalizedOutcome(validated, 'failure-finalize', finalTime),
    ).toMatchObject({
      terminalState: 'failed',
      execution: 'exited',
      result: 'none',
      evidence: { kind: 'no-deliverable', terminalFactId: 'terminal-1' },
      evidenceValidation: { status: 'not-applicable' },
    });
  });

  it.each([
    ['failure', 'failed', 'exited'],
    ['timed_out', 'failed', 'timed_out'],
    ['skipped', 'failed', 'not_started'],
    ['cancelled', 'cancelled', 'cancelled'],
  ] as const)(
    'derives one legal %s terminal outcome without local cancellation provenance',
    async (conclusion, terminalState, execution) => {
      const observed = await resultObserved(conclusion);
      const validating = applied(
        reduceAttempt(
          observed,
          transition(
            observed,
            {
              kind: 'start-validation',
              eventId: `start-${conclusion}`,
              at: deadline,
            },
            deadline,
          ),
        ),
      ).state;
      const eventId = `finalize-${conclusion}`;
      const outcome = deriveFinalizedOutcome(validating, eventId, finalTime);
      expect(outcome).toMatchObject({ terminalState, execution });
      expect(
        reduceAttempt(
          validating,
          transition(
            validating,
            { kind: 'finalize', eventId, outcome },
            finalTime,
          ),
        ).status,
      ).toBe('applied');
    },
  );

  it('finalizes multiple valid claims as ambiguity without inventing a reference', async () => {
    let state = await resultObserved();
    for (const [factId, claim] of [
      [
        'claim-1',
        {
          kind: 'pull-request',
          number: 12,
          localAttemptMarker: 'g1:intent-1',
        },
      ],
      [
        'claim-2',
        {
          kind: 'comment',
          commentId: 'comment-2',
          localAttemptMarker: 'g1:intent-1',
        },
      ],
    ] as const) {
      const event = await observation(factId, {
        kind: 'agent-result-claim',
        claim,
      });
      state = applied(reduceAttempt(state, transition(state, event))).state;
    }
    const started = applied(
      reduceAttempt(
        state,
        transition(
          state,
          { kind: 'start-validation', eventId: 'start-many', at: deadline },
          deadline,
        ),
      ),
    );
    expect(started.effects).toHaveLength(2);
    state = started.state;
    for (const factId of ['claim-1', 'claim-2']) {
      const validationId = `validation-${factId}`;
      state = applied(
        reduceAttempt(
          state,
          transition(
            state,
            {
              kind: 'validate-claim',
              eventId: validationId,
              claimFactId: factId,
              validation: {
                status: 'validated',
                validationFactId: validationId,
                validatedAt: validationTime,
              },
            },
            validationTime,
          ),
        ),
      ).state;
    }
    const outcome: AttemptOutcome = {
      ...failedNoDeliverable('terminal-1', 'finalize-many'),
      result: 'outcome-gate-failure',
      failure: { ...failure, reason: 'deliverable_unattributable' },
      evidenceValidation: {
        status: 'ambiguous',
        validationFactId: 'finalize-many',
        candidateCount: 2,
        validatedAt: finalTime,
      },
    };
    const finalized = applied(
      reduceAttempt(
        state,
        transition(
          state,
          { kind: 'finalize', eventId: 'finalize-many', outcome },
          finalTime,
        ),
      ),
    );
    expect(finalized.state.outcome?.reference).toBeUndefined();
    expect(finalized.state.outcome?.evidenceValidation.status).toBe(
      'ambiguous',
    );
  });

  it('keeps cancellation authoritative across delayed binding and verified terminalization', async () => {
    const registered = applied(reduceAttempt(undefined, register())).state;
    const cancelling = applied(
      reduceAttempt(
        registered,
        transition(registered, {
          kind: 'request-cancel',
          eventId: 'cancel-1',
        }),
      ),
    ).state;
    const bound = await observation('bound-1', { kind: 'run-bound', binding });
    let state = applied(
      reduceAttempt(cancelling, transition(cancelling, bound)),
    ).state;
    expect(state.phase).toBe('cancelling');
    expect(state.futureGrantsDenied).toBe(true);

    const terminal = await observation('terminal-1', {
      kind: 'run-terminal',
      binding,
      conclusion: 'cancelled',
      observedAt: later,
    });
    state = applied(reduceAttempt(state, transition(state, terminal))).state;
    state = applied(
      reduceAttempt(
        state,
        transition(
          state,
          { kind: 'start-validation', eventId: 'start-cancel', at: deadline },
          deadline,
        ),
      ),
    ).state;
    const outcome = lifecycleOutcome('cancelled', 'cancel-1');
    const finalized = applied(
      reduceAttempt(
        state,
        transition(
          state,
          { kind: 'finalize', eventId: 'finalize-cancel', outcome },
          finalTime,
        ),
      ),
    );
    expect(finalized.state.outcome).toEqual(outcome);
    expect(finalized.effects.map((effect) => effect.kind)).not.toContain(
      'deny-future-grants',
    );
  });

  it('requires contextual immutable outcomes for rejected and lost launches', () => {
    const registered = applied(reduceAttempt(undefined, register())).state;
    const claim: AgentResultClaimV1 = {
      kind: 'pull-request',
      number: 12,
      localAttemptMarker: 'g1:intent-1',
    };
    expect(
      reduceAttempt(
        registered,
        transition(registered, {
          kind: 'launch-rejected',
          eventId: 'reject-1',
          outcome: successfulPullRequest(claim, 'validation-1', later),
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });

    const rejected = applied(
      reduceAttempt(
        registered,
        transition(registered, {
          kind: 'launch-rejected',
          eventId: 'reject-1',
          outcome: launchRejectedOutcome('reject-1'),
        }),
      ),
    );
    expect(rejected.state.phase).toBe('terminal');
    expect(rejected.state.outcome?.execution).toBe('not_started');

    expect(
      reduceAttempt(
        registered,
        transition(registered, {
          kind: 'mark-lost',
          eventId: 'lost-1',
          outcome: successfulPullRequest(claim, 'validation-1', later),
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-input' });
    const lost = applied(
      reduceAttempt(
        registered,
        transition(registered, {
          kind: 'mark-lost',
          eventId: 'lost-1',
          outcome: lifecycleOutcome('lost', 'lost-1', later),
        }),
      ),
    );
    expect(lost.state.outcome?.terminalState).toBe('lost');
  });

  it('keeps finalization live when cancellation arrives after terminal observation', async () => {
    const observed = await resultObserved();
    const cancelled = applied(
      reduceAttempt(
        observed,
        transition(observed, {
          kind: 'request-cancel',
          eventId: 'cancel-after-terminal',
        }),
      ),
    ).state;
    expect(cancelled.phase).toBe('result-observed');
    expect(cancelled.cancellation?.eventId).toBe('cancel-after-terminal');
    const validating = applied(
      reduceAttempt(
        cancelled,
        transition(
          cancelled,
          {
            kind: 'start-validation',
            eventId: 'start-after-cancel',
            at: deadline,
          },
          deadline,
        ),
      ),
    ).state;
    const outcome = failedNoDeliverable('terminal-1', 'finalize-after-cancel');
    const finalized = applied(
      reduceAttempt(
        validating,
        transition(
          validating,
          {
            kind: 'finalize',
            eventId: 'finalize-after-cancel',
            outcome,
          },
          finalTime,
        ),
      ),
    );
    expect(finalized.state.outcome).toEqual(outcome);
  });

  it('terminalizes a proven unlaunched cancellation and blocks no-run claims after execution evidence', async () => {
    const registered = applied(reduceAttempt(undefined, register())).state;
    const unlaunchedOutcome: AttemptOutcome = {
      ...lifecycleOutcome('superseded', 'cancel-unlaunched', later),
      execution: 'not_started',
    };
    const unlaunched = applied(
      reduceAttempt(
        registered,
        transition(registered, {
          kind: 'cancel-unlaunched',
          eventId: 'cancel-unlaunched',
          supersededByIntentId: 'intent-2',
          outcome: unlaunchedOutcome,
        }),
      ),
    );
    expect(unlaunched.state.outcome).toEqual(unlaunchedOutcome);
    expect(unlaunched.effects.map((effect) => effect.kind)).toEqual([
      'deny-future-grants',
    ]);

    const terminal = await observation('terminal-prebind', {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: later,
    });
    const pending = applied(
      reduceAttempt(registered, transition(registered, terminal)),
    ).state;
    expect(
      reduceAttempt(
        pending,
        transition(pending, {
          kind: 'launch-rejected',
          eventId: 'reject-after-terminal',
          outcome: launchRejectedOutcome('reject-after-terminal'),
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-transition' });
    expect(
      reduceAttempt(
        pending,
        transition(pending, {
          kind: 'mark-lost',
          eventId: 'lost-after-terminal',
          outcome: lifecycleOutcome('lost', 'lost-after-terminal', later),
        }),
      ),
    ).toMatchObject({ status: 'conflict', conflict: 'invalid-transition' });
  });
});
