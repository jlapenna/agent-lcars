import { createHash } from 'node:crypto';

import type {
  ActivationProvenance,
  ActivationRecord,
  CanonicalTaskIdentity,
  ControlPlaneSignalEnvelope,
  DesiredIntentRelation,
  IntentRevision,
  PolicyDecision,
  TenantRef,
} from '@agent-lcars/dispatch-contracts';
import {
  activationRecordSchema,
  controlPlaneSignalEnvelopeSchema,
  policyDecisionSchema,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';

const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function isUtcDateTime(value: string): boolean {
  return utcDateTimeSchema.safeParse(value).success;
}

export interface IntentOrderingKey {
  occurredAt: string;
  tieBreaker: string;
}

export interface IntentCandidate {
  intentId: string;
  semanticKey: string;
  semanticDigest: string;
  orderingKey: IntentOrderingKey;
}

export interface StoredIntentRevision extends IntentRevision {
  semanticKey: string;
  semanticDigest: string;
  orderingKey: IntentOrderingKey;
}

export type TaskAttemptRelation =
  | { kind: 'none' }
  | { kind: 'unlaunched'; intentId: string }
  | {
      kind: 'launched';
      intentId: string;
      staleForDesiredState: boolean;
      cancellationRequested: boolean;
      supersededByIntentId?: string;
    };

export type TaskIntentResolution =
  | {
      kind: 'desired';
      taskRevision: number;
      intentId: string;
      intentRevision: number;
    }
  | {
      kind: 'stale';
      taskRevision: number;
      intentId: string;
      intentRevision: number;
    }
  | {
      kind: 'semantic-duplicate';
      taskRevision: number;
      intentId: string;
      intentRevision: number;
    }
  | {
      kind: 'parked';
      taskRevision: number;
      intentId?: string;
      intentRevision?: number;
    }
  | {
      kind: 'cancelled';
      taskRevision: number;
      intentId?: string;
      intentRevision?: number;
    }
  | { kind: 'rejected'; taskRevision: number }
  | { kind: 'observed'; taskRevision: number };

export interface AcceptedTaskFact {
  factId: string;
  requestId: string;
  sourceKey: string;
  canonicalDigest: string;
  policyDecision: PolicyDecision;
  resolution: TaskIntentResolution;
  acceptedAt: string;
}

export interface TaskIntentState {
  schema: 'agent-lcars.task-intent-state/v1';
  version: 1;
  tenant: TenantRef;
  task: CanonicalTaskIdentity;
  revision: number;
  activation: ActivationProvenance;
  facts: AcceptedTaskFact[];
  intents: StoredIntentRevision[];
  desired?: DesiredIntentRelation;
  attempt: TaskAttemptRelation;
  updatedAt: string;
}

export type TaskIntentEffect =
  | {
      kind: 'admit-attempt';
      effectKey: string;
      task: CanonicalTaskIdentity;
      intentId: string;
      intentRevision: number;
      activation: ActivationProvenance;
    }
  | {
      kind: 'cancel-unlaunched';
      effectKey: string;
      task: CanonicalTaskIdentity;
      intentId: string;
      activation: ActivationProvenance;
    }
  | {
      kind: 'cancel-or-drain';
      effectKey: string;
      task: CanonicalTaskIdentity;
      intentId: string;
      supersededByIntentId?: string;
      activation: ActivationProvenance;
    }
  | {
      kind: 'park-projection';
      effectKey: string;
      task: CanonicalTaskIdentity;
      intentId?: string;
      activation: ActivationProvenance;
    };

export interface ReduceTaskIntentInput {
  expectedRevision: number;
  transitionedAt: string;
  canonicalDigest: string;
  envelope: ControlPlaneSignalEnvelope;
  policyDecision: PolicyDecision;
  activation: ActivationRecord;
  candidate?: IntentCandidate;
}

export type TaskIntentDigestInput = Omit<
  ReduceTaskIntentInput,
  'canonicalDigest' | 'expectedRevision' | 'transitionedAt'
>;

export type TaskIntentConflictKind =
  | 'activation-mismatch'
  | 'digest-conflict'
  | 'invalid-input'
  | 'revision-conflict'
  | 'semantic-conflict'
  | 'task-mismatch';

export type ReduceTaskIntentResult =
  | {
      status: 'applied';
      state: TaskIntentState;
      resolution: TaskIntentResolution;
      effects: TaskIntentEffect[];
    }
  | {
      status: 'replay';
      state: TaskIntentState;
      resolution: TaskIntentResolution;
      effects: [];
    }
  | {
      status: 'conflict';
      state: TaskIntentState | undefined;
      conflict: TaskIntentConflictKind;
      message: string;
      effects: [];
    };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

/** Canonical immutable command material used for replay/conflict detection. */
export function canonicalTaskIntentInput(input: TaskIntentDigestInput): string {
  const material: TaskIntentDigestInput = {
    envelope: input.envelope,
    policyDecision: input.policyDecision,
    activation: input.activation,
    ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
  };
  return JSON.stringify(canonicalJsonValue(material));
}

export function taskIntentInputDigest(input: TaskIntentDigestInput): string {
  return createHash('sha256')
    .update(canonicalTaskIntentInput(input))
    .digest('hex');
}

function sourceKey(envelope: ControlPlaneSignalEnvelope): string {
  switch (envelope.source.kind) {
    case 'github-webhook':
      return `github:${envelope.source.deliveryId}`;
    case 'operator-command':
      return `operator:${envelope.source.operatorId}:${envelope.source.commandId}`;
    case 'schedule-reconcile':
      return `scheduler:${envelope.source.schedulerId}:${envelope.source.scanKey}`;
  }
}

function activationProvenance(
  activation: ActivationRecord,
): ActivationProvenance | undefined {
  if (activation.mode === 'retired') return undefined;
  return {
    activationId: activation.activationId,
    taskClassId: activation.taskClassId,
    authorityEpoch: activation.authorityEpoch,
    mode: activation.mode,
  };
}

function sameTask(
  left: CanonicalTaskIdentity,
  right: CanonicalTaskIdentity,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.repositoryId === right.repositoryId &&
    left.issueNumber === right.issueNumber
  );
}

function sameTenantAuthority(left: TenantRef, right: TenantRef): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.repositoryId === right.repositoryId &&
    left.installationId === right.installationId
  );
}

function sameActivation(
  left: ActivationProvenance,
  right: ActivationProvenance,
): boolean {
  return (
    left.activationId === right.activationId &&
    left.taskClassId === right.taskClassId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.mode === right.mode
  );
}

function policyPrincipalMatchesSource(
  envelope: ControlPlaneSignalEnvelope,
  decision: PolicyDecision,
): boolean {
  switch (envelope.source.kind) {
    case 'github-webhook':
      return (
        decision.principal.kind === 'github-actor' &&
        decision.principal.actorId === envelope.source.actorId
      );
    case 'operator-command':
      return (
        decision.principal.kind === 'operator' &&
        decision.principal.operatorId === envelope.source.operatorId
      );
    case 'schedule-reconcile':
      return (
        decision.principal.kind === 'system' &&
        decision.principal.systemId === envelope.source.schedulerId
      );
  }
}

export function compareIntentOrdering(
  left: IntentOrderingKey,
  right: IntentOrderingKey,
): number {
  const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  return byTime || left.tieBreaker.localeCompare(right.tieBreaker);
}

function latestSemanticIntent(
  state: TaskIntentState,
  semanticKey: string,
): StoredIntentRevision | undefined {
  for (let index = state.intents.length - 1; index >= 0; index -= 1) {
    const intent = state.intents[index];
    if (intent?.semanticKey === semanticKey) return intent;
  }
  return undefined;
}

function latestIntentRevision(
  state: TaskIntentState,
  intentId: string,
): StoredIntentRevision | undefined {
  return state.intents
    .filter((intent) => intent.intentId === intentId)
    .sort((left, right) => right.revision - left.revision)[0];
}

function appendIntentRevision(
  intents: StoredIntentRevision[],
  input: {
    state: TaskIntentState;
    intentId: string;
    status: IntentRevision['status'];
    sourceFactId: string;
    policyDecision: PolicyDecision;
    activation: ActivationProvenance;
    createdAt: string;
    semanticKey: string;
    semanticDigest: string;
    orderingKey: IntentOrderingKey;
  },
): StoredIntentRevision {
  const previous = latestIntentRevision(input.state, input.intentId);
  const revision = (previous?.revision ?? 0) + 1;
  const intent: StoredIntentRevision = {
    schema: 'agent-lcars.intent/v1',
    version: 1,
    task: clone(input.state.task),
    intentId: input.intentId,
    revision,
    status: input.status,
    sourceFactId: input.sourceFactId,
    policyDecision: clone(input.policyDecision),
    activation: clone(input.activation),
    createdAt: input.createdAt,
    semanticKey: input.semanticKey,
    semanticDigest: input.semanticDigest,
    orderingKey: clone(input.orderingKey),
  };
  intents.push(intent);
  return intent;
}

function conflict(
  state: TaskIntentState | undefined,
  kind: TaskIntentConflictKind,
  message: string,
): ReduceTaskIntentResult {
  return { status: 'conflict', state, conflict: kind, message, effects: [] };
}

function initialState(
  input: ReduceTaskIntentInput,
  activation: ActivationProvenance,
): TaskIntentState {
  return {
    schema: 'agent-lcars.task-intent-state/v1',
    version: 1,
    tenant: clone(input.envelope.tenant),
    task: clone(input.envelope.task),
    revision: 0,
    activation: clone(activation),
    facts: [],
    intents: [],
    attempt: { kind: 'none' },
    updatedAt: input.transitionedAt,
  };
}

function centralEffects(
  activation: ActivationProvenance,
  effects: TaskIntentEffect[],
): TaskIntentEffect[] {
  return activation.mode === 'central-authoritative' ? effects : [];
}

/**
 * Reduce one already-authenticated and centrally authorized signal.
 *
 * The function has no clock, ID, provider, persistence, or projection access.
 * Exact replay is checked before revision CAS and never re-emits effects.
 */
export function reduceTaskIntent(
  current: TaskIntentState | undefined,
  input: ReduceTaskIntentInput,
): ReduceTaskIntentResult {
  const expectedDigest = taskIntentInputDigest({
    envelope: input.envelope,
    policyDecision: input.policyDecision,
    activation: input.activation,
    ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
  });
  const candidateValid =
    input.candidate === undefined ||
    (OPAQUE_ID.test(input.candidate.intentId) &&
      OPAQUE_ID.test(input.candidate.semanticKey) &&
      SHA256.test(input.candidate.semanticDigest) &&
      isUtcDateTime(input.candidate.orderingKey.occurredAt) &&
      OPAQUE_ID.test(input.candidate.orderingKey.tieBreaker));
  if (
    !controlPlaneSignalEnvelopeSchema.safeParse(input.envelope).success ||
    !policyDecisionSchema.safeParse(input.policyDecision).success ||
    !activationRecordSchema.safeParse(input.activation).success ||
    !SHA256.test(input.canonicalDigest) ||
    input.canonicalDigest !== expectedDigest ||
    !isUtcDateTime(input.transitionedAt) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !candidateValid
  ) {
    return conflict(
      current,
      'invalid-input',
      'Reducer input must satisfy the closed control-plane contracts',
    );
  }
  const provenance = activationProvenance(input.activation);
  if (provenance === undefined) {
    return conflict(
      current,
      'activation-mismatch',
      'A retired activation cannot accept a new task signal',
    );
  }
  if (
    !sameTenantAuthority(input.activation.tenant, input.envelope.tenant) ||
    !sameTask(input.envelope.task, {
      tenantId: input.activation.tenant.tenantId,
      repositoryId: input.activation.tenant.repositoryId,
      issueNumber: input.envelope.task.issueNumber,
    })
  ) {
    return conflict(
      current,
      'task-mismatch',
      'Activation, tenant, and signal task authority must agree',
    );
  }
  if (input.policyDecision.sourceFactId !== input.envelope.factId) {
    return conflict(
      current,
      'invalid-input',
      'Policy decision must reference the signal fact',
    );
  }
  if (!policyPrincipalMatchesSource(input.envelope, input.policyDecision)) {
    return conflict(
      current,
      'invalid-input',
      'Policy principal must match the authenticated signal source',
    );
  }
  const candidateRequired = input.envelope.signal.kind === 'requested-work';
  if (candidateRequired !== (input.candidate !== undefined)) {
    return conflict(
      current,
      'invalid-input',
      'Exactly requested-work signals require an intent candidate',
    );
  }

  const state = current ?? initialState(input, provenance);
  if (
    !sameTask(state.task, input.envelope.task) ||
    !sameTenantAuthority(state.tenant, input.envelope.tenant)
  ) {
    return conflict(current, 'task-mismatch', 'Signal belongs to another task');
  }
  if (!sameActivation(state.activation, provenance)) {
    return conflict(
      current,
      'activation-mismatch',
      'Task is pinned to another authority activation',
    );
  }

  const derivedSourceKey = sourceKey(input.envelope);
  const replayMatches = state.facts.filter(
    (fact) =>
      fact.factId === input.envelope.factId ||
      fact.requestId === input.envelope.requestId ||
      fact.sourceKey === derivedSourceKey,
  );
  if (replayMatches.length > 0) {
    const recorded = replayMatches[0];
    if (
      replayMatches.some(
        (match) =>
          match.factId !== recorded.factId ||
          match.requestId !== recorded.requestId ||
          match.sourceKey !== recorded.sourceKey ||
          match.canonicalDigest !== recorded.canonicalDigest,
      ) ||
      recorded.canonicalDigest !== input.canonicalDigest
    ) {
      return conflict(
        current,
        'digest-conflict',
        'A fact, request, or authenticated source key was reused differently',
      );
    }
    return {
      status: 'replay',
      state,
      resolution: clone(recorded.resolution),
      effects: [],
    };
  }

  if (input.expectedRevision !== state.revision) {
    return conflict(
      current,
      'revision-conflict',
      `Expected task revision ${input.expectedRevision}, found ${state.revision}`,
    );
  }

  const next: TaskIntentState = {
    ...state,
    revision: state.revision + 1,
    facts: [...state.facts],
    intents: [...state.intents],
    desired: state.desired === undefined ? undefined : clone(state.desired),
    attempt: clone(state.attempt),
    updatedAt: input.transitionedAt,
  };
  const effects: TaskIntentEffect[] = [];
  let resolution: TaskIntentResolution;

  if (input.envelope.signal.kind === 'requested-work') {
    const candidate = input.candidate as IntentCandidate;
    const intentIdentityMatch = state.intents.find(
      (intent) => intent.intentId === candidate.intentId,
    );
    if (
      intentIdentityMatch !== undefined &&
      (intentIdentityMatch.semanticKey !== candidate.semanticKey ||
        intentIdentityMatch.semanticDigest !== candidate.semanticDigest)
    ) {
      return conflict(
        current,
        'semantic-conflict',
        'An intent ID was reused with different semantic identity',
      );
    }
    const conflictingSemanticMatch = state.intents.find(
      (intent) =>
        intent.semanticKey === candidate.semanticKey &&
        intent.semanticDigest !== candidate.semanticDigest,
    );
    if (conflictingSemanticMatch !== undefined) {
      return conflict(
        current,
        'semantic-conflict',
        'A semantic intent key was reused with a different digest',
      );
    }
    const latestSemanticMatch = latestSemanticIntent(
      state,
      candidate.semanticKey,
    );
    const semanticMatch = state.intents.find(
      (intent) => intent.semanticKey === candidate.semanticKey,
    );
    const retriesParkedIntent =
      input.policyDecision.decision === 'accepted' &&
      input.envelope.source.kind === 'operator-command' &&
      input.envelope.source.command === 'retry' &&
      state.desired === undefined &&
      latestSemanticMatch?.status === 'parked' &&
      candidate.intentId !== latestSemanticMatch.intentId;
    if (semanticMatch !== undefined && !retriesParkedIntent) {
      const latest = latestSemanticMatch as StoredIntentRevision;
      resolution = {
        kind: 'semantic-duplicate',
        taskRevision: next.revision,
        intentId: latest.intentId,
        intentRevision: latest.revision,
      };
    } else if (input.policyDecision.decision === 'rejected') {
      const parked = appendIntentRevision(next.intents, {
        state,
        ...candidate,
        status: 'parked',
        sourceFactId: input.envelope.factId,
        policyDecision: input.policyDecision,
        activation: provenance,
        createdAt: input.transitionedAt,
      });
      resolution = {
        kind: 'parked',
        taskRevision: next.revision,
        intentId: parked.intentId,
        intentRevision: parked.revision,
      };
      effects.push({
        kind: 'park-projection',
        effectKey: `${input.envelope.factId}:park-projection`,
        task: clone(state.task),
        intentId: parked.intentId,
        activation: clone(provenance),
      });
    } else {
      const currentDesired =
        state.desired === undefined
          ? undefined
          : latestIntentRevision(state, state.desired.intentId);
      const isNewDesired =
        currentDesired === undefined ||
        compareIntentOrdering(
          candidate.orderingKey,
          currentDesired.orderingKey,
        ) > 0 ||
        (compareIntentOrdering(
          candidate.orderingKey,
          currentDesired.orderingKey,
        ) === 0 &&
          candidate.semanticKey.localeCompare(currentDesired.semanticKey) > 0);
      if (!isNewDesired) {
        const stale = appendIntentRevision(next.intents, {
          state,
          ...candidate,
          status: 'superseded',
          sourceFactId: input.envelope.factId,
          policyDecision: input.policyDecision,
          activation: provenance,
          createdAt: input.transitionedAt,
        });
        resolution = {
          kind: 'stale',
          taskRevision: next.revision,
          intentId: stale.intentId,
          intentRevision: stale.revision,
        };
      } else {
        if (currentDesired !== undefined) {
          appendIntentRevision(next.intents, {
            state: { ...state, intents: next.intents },
            intentId: currentDesired.intentId,
            status: 'superseded',
            sourceFactId: input.envelope.factId,
            policyDecision: input.policyDecision,
            activation: provenance,
            createdAt: input.transitionedAt,
            semanticKey: currentDesired.semanticKey,
            semanticDigest: currentDesired.semanticDigest,
            orderingKey: currentDesired.orderingKey,
          });
        }
        const desired = appendIntentRevision(next.intents, {
          state,
          ...candidate,
          status: 'desired',
          sourceFactId: input.envelope.factId,
          policyDecision: input.policyDecision,
          activation: provenance,
          createdAt: input.transitionedAt,
        });
        next.desired = {
          task: clone(state.task),
          intentId: desired.intentId,
          intentRevision: desired.revision,
          selectedAt: input.transitionedAt,
          ...(currentDesired === undefined
            ? {}
            : { supersedesIntentId: currentDesired.intentId }),
        };
        if (state.attempt.kind === 'launched') {
          next.attempt = {
            ...state.attempt,
            staleForDesiredState: true,
            cancellationRequested: true,
            supersededByIntentId: desired.intentId,
          };
          if (!state.attempt.cancellationRequested) {
            effects.push({
              kind: 'cancel-or-drain',
              effectKey: `${input.envelope.factId}:cancel-or-drain`,
              task: clone(state.task),
              intentId: state.attempt.intentId,
              supersededByIntentId: desired.intentId,
              activation: clone(provenance),
            });
          }
        } else {
          next.attempt = { kind: 'unlaunched', intentId: desired.intentId };
          effects.push({
            kind: 'admit-attempt',
            effectKey: `${input.envelope.factId}:admit-attempt`,
            task: clone(state.task),
            intentId: desired.intentId,
            intentRevision: desired.revision,
            activation: clone(provenance),
          });
        }
        resolution = {
          kind: 'desired',
          taskRevision: next.revision,
          intentId: desired.intentId,
          intentRevision: desired.revision,
        };
      }
    }
  } else if (input.policyDecision.decision === 'rejected') {
    resolution = { kind: 'rejected', taskRevision: next.revision };
  } else if (input.envelope.signal.kind === 'reconcile') {
    resolution = { kind: 'observed', taskRevision: next.revision };
  } else {
    const desired =
      state.desired === undefined
        ? undefined
        : latestIntentRevision(state, state.desired.intentId);
    const status =
      input.envelope.signal.kind === 'park' ? 'parked' : 'cancelled';
    let changed: StoredIntentRevision | undefined;
    if (desired !== undefined) {
      changed = appendIntentRevision(next.intents, {
        state: { ...state, intents: next.intents },
        intentId: desired.intentId,
        status,
        sourceFactId: input.envelope.factId,
        policyDecision: input.policyDecision,
        activation: provenance,
        createdAt: input.transitionedAt,
        semanticKey: desired.semanticKey,
        semanticDigest: desired.semanticDigest,
        orderingKey: desired.orderingKey,
      });
      next.desired = undefined;
    }
    if (state.attempt.kind === 'unlaunched') {
      effects.push({
        kind: 'cancel-unlaunched',
        effectKey: `${input.envelope.factId}:cancel-unlaunched`,
        task: clone(state.task),
        intentId: state.attempt.intentId,
        activation: clone(provenance),
      });
      next.attempt = { kind: 'none' };
    } else if (state.attempt.kind === 'launched') {
      if (!state.attempt.cancellationRequested) {
        effects.push({
          kind: 'cancel-or-drain',
          effectKey: `${input.envelope.factId}:cancel-or-drain`,
          task: clone(state.task),
          intentId: state.attempt.intentId,
          activation: clone(provenance),
        });
      }
      next.attempt = {
        ...state.attempt,
        staleForDesiredState: true,
        cancellationRequested: true,
      };
    }
    if (input.envelope.signal.kind === 'park') {
      effects.push({
        kind: 'park-projection',
        effectKey: `${input.envelope.factId}:park-projection`,
        task: clone(state.task),
        ...(changed === undefined ? {} : { intentId: changed.intentId }),
        activation: clone(provenance),
      });
      resolution = {
        kind: 'parked',
        taskRevision: next.revision,
        ...(changed === undefined
          ? {}
          : { intentId: changed.intentId, intentRevision: changed.revision }),
      };
    } else {
      resolution = {
        kind: 'cancelled',
        taskRevision: next.revision,
        ...(changed === undefined
          ? {}
          : { intentId: changed.intentId, intentRevision: changed.revision }),
      };
    }
  }

  next.facts.push({
    factId: input.envelope.factId,
    requestId: input.envelope.requestId,
    sourceKey: derivedSourceKey,
    canonicalDigest: input.canonicalDigest,
    policyDecision: clone(input.policyDecision),
    resolution: clone(resolution),
    acceptedAt: input.transitionedAt,
  });
  return {
    status: 'applied',
    state: next,
    resolution,
    effects: centralEffects(provenance, effects),
  };
}
