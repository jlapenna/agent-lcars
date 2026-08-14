import type {
  AcceptedAttemptSpec,
  CanonicalTaskIdentity,
  TenantRef,
} from '@agent-lcars/dispatch-contracts';

import { mintAttemptAdmission } from './admission-capability';
import type {
  AdmissionResult,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
} from './authority-storage';
import type {
  StoredIntentRevision,
  TaskIntentState,
} from './task-intent-reducer';

export class TaskAttemptAdmissionConflict extends Error {
  override name = 'TaskAttemptAdmissionConflict';
}

/** Production mints a CSPRNG global id; tests inject a deterministic fake. */
/**
 * Server-owned policy catalog seam. It resolves execution capability from the
 * immutable accepted decision; no transport or client can select this plan.
 */
export interface AdmissionPlanResolver {
  resolve(input: {
    tenant: TenantRef;
    task: CanonicalTaskIdentity;
    intent: StoredIntentRevision;
  }): Promise<AcceptedAttemptSpec['execution']>;
}

function selectedIntent(
  state: TaskIntentState,
  directive: {
    intentId: string;
    intentRevision: number;
  },
): {
  intent: StoredIntentRevision;
  requestId: string;
} {
  const desired = state.desired;
  if (state.attempt.kind !== 'unlaunched' || desired === undefined) {
    throw new TaskAttemptAdmissionConflict(
      'Task has no unlaunched desired intent',
    );
  }
  if (
    state.attempt.intentId !== directive.intentId ||
    desired.intentId !== directive.intentId ||
    desired.intentRevision !== directive.intentRevision
  ) {
    throw new TaskAttemptAdmissionConflict(
      'Task attempt and desired intent disagree',
    );
  }
  const intent = state.intents.find(
    (candidate) =>
      candidate.intentId === directive.intentId &&
      candidate.revision === directive.intentRevision,
  );
  const source = state.facts.find(
    (fact) => fact.factId === intent?.sourceFactId,
  );
  if (
    intent === undefined ||
    intent.status !== 'desired' ||
    intent.policyDecision.decision !== 'accepted' ||
    source === undefined
  ) {
    throw new TaskAttemptAdmissionConflict(
      'Desired intent provenance is invalid',
    );
  }
  return { intent, requestId: source.requestId };
}

/**
 * Inactive service composition seam. It performs no launch itself; storage
 * atomically records the launch outbox before any future provider worker runs.
 */
export class TaskAttemptAdmissionCoordinator {
  constructor(
    private readonly storage: LifecycleAuthorityStorage,
    private readonly plans: AdmissionPlanResolver,
  ) {}

  async admit(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: CanonicalTaskIdentity;
    intentId: string;
    intentRevision: number;
  }): Promise<AdmissionResult> {
    const replay = await this.storage.readAttemptAdmission({
      lease: input.lease,
      tenantId: input.tenantId,
      task: input.task,
      intentId: input.intentId,
      intentRevision: input.intentRevision,
    });
    if (replay !== undefined) return replay;
    const state = await this.storage.readTask(input.task);
    if (state === undefined || state.tenant.tenantId !== input.tenantId) {
      throw new TaskAttemptAdmissionConflict('Tenant-scoped task is unknown');
    }
    const { intent } = selectedIntent(state, input);
    const execution = await this.plans.resolve({
      tenant: structuredClone(state.tenant),
      task: structuredClone(state.task),
      intent: structuredClone(intent),
    });
    return this.storage.admitVerifiedAttemptAndRecordLaunch({
      lease: input.lease,
      admission: mintAttemptAdmission({
        tenant: state.tenant,
        task: state.task,
        expectedTaskRevision: state.revision,
        intentId: intent.intentId,
        intentRevision: intent.revision,
        activation: state.activation,
        execution,
      }),
    });
  }
}
