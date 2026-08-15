import 'server-only';

import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { controlPlaneSignalEnvelopeSchema } from '@agent-lcars/dispatch-contracts';

import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  TaskAuthorityScope,
  TaskEffectRecord,
  TaskEffectTransitionResult,
} from './authority-storage';
import {
  GitHubWebhookNormalizer,
  GitHubWebhookVerifier,
  type IngressInboxRecord,
  type IngressPolicyInbox,
  type IngressRecordResult,
  stableIngressDeliverySha256,
  type VerifiedControlPlaneSignalEnvelope,
  type VerifyGitHubWebhookInput,
} from './ingress-policy';
import { TaskEffectTransitionCoordinator } from './task-effects';
import type { IntentCandidate } from './task-intent-reducer';

export interface TaskActivationResolver {
  resolve(input: {
    envelope: VerifiedControlPlaneSignalEnvelope;
    policyDecision: PolicyDecision;
  }): Promise<ActivationRecord | undefined>;
}

export interface IntentCandidateResolver {
  resolve(input: {
    envelope: VerifiedControlPlaneSignalEnvelope;
    policyDecision: PolicyDecision;
  }): Promise<IntentCandidate | undefined>;
}

/** Owns lease identity and lifetime; callers cannot provide a lease. */
export interface TaskLeaseRunner {
  run<T>(
    scope: TaskAuthorityScope,
    operation: (lease: TaskAuthorityLease) => Promise<T>,
  ): Promise<T>;
}

export interface SignalTaskCompositionDependencies {
  webhookVerifier: GitHubWebhookVerifier;
  webhookNormalizer: GitHubWebhookNormalizer;
  inbox: IngressPolicyInbox;
  storage: LifecycleAuthorityStorage;
  activation: TaskActivationResolver;
  candidate: IntentCandidateResolver;
  leases: TaskLeaseRunner;
  clock: AuthorityClock;
}

/** Public effect receipt; storage claim fences/tokens stay private. */
export type SanitizedTaskEffectRecord = Omit<
  TaskEffectRecord,
  'claimedFence' | 'claimToken'
>;

/** Public task transition receipt with no raw storage capabilities. */
export type SanitizedTaskEffectTransitionResult = Omit<
  TaskEffectTransitionResult,
  'effects'
> & {
  effects: SanitizedTaskEffectRecord[];
};

export interface SignalTaskTransitionMetadata {
  delivery: Pick<
    IngressInboxRecord,
    'tenantId' | 'deliveryId' | 'requestId' | 'factId' | 'repositoryId'
  > & { status: IngressRecordResult['status'] };
  transition: SanitizedTaskEffectTransitionResult;
}

export class SignalTaskCompositionConflict extends Error {
  override name = 'SignalTaskCompositionConflict';
}

function taskScope(
  envelope: VerifiedControlPlaneSignalEnvelope,
): TaskAuthorityScope {
  return {
    tenantId: envelope.tenant.tenantId,
    repositoryId: envelope.tenant.repositoryId,
    issueNumber: envelope.task.issueNumber,
  };
}

function assertSameNormalizedEnvelope(
  fresh: VerifiedControlPlaneSignalEnvelope,
  durable: ControlPlaneSignalEnvelope,
  recordedInputSha256: string,
): asserts durable is VerifiedControlPlaneSignalEnvelope {
  if (
    !controlPlaneSignalEnvelopeSchema.safeParse(durable).success ||
    stableIngressDeliverySha256(fresh) !== recordedInputSha256 ||
    stableIngressDeliverySha256(durable) !== recordedInputSha256 ||
    fresh.requestId !== durable.requestId ||
    fresh.factId !== durable.factId ||
    fresh.task.tenantId !== durable.task.tenantId ||
    fresh.task.repositoryId !== durable.task.repositoryId ||
    fresh.task.issueNumber !== durable.task.issueNumber
  ) {
    throw new SignalTaskCompositionConflict(
      'Durable inbox handoff does not match normalized delivery',
    );
  }
}

function sameTenantTask(
  activation: ActivationRecord,
  envelope: ControlPlaneSignalEnvelope,
): boolean {
  return (
    activation.tenant.tenantId === envelope.tenant.tenantId &&
    activation.tenant.repositoryId === envelope.tenant.repositoryId &&
    envelope.task.tenantId === envelope.tenant.tenantId &&
    envelope.task.repositoryId === envelope.tenant.repositoryId
  );
}

function sanitizeTransition(
  transition: TaskEffectTransitionResult,
): SanitizedTaskEffectTransitionResult {
  const sanitizeEffect = (
    effect: TaskEffectRecord,
  ): SanitizedTaskEffectRecord => {
    const {
      claimedFence: _claimedFence,
      claimToken: _claimToken,
      ...safe
    } = effect;
    return structuredClone(safe);
  };
  return {
    ...structuredClone(transition),
    effects: transition.effects.map(sanitizeEffect),
  };
}

/**
 * Inactive server composition for one authenticated GitHub webhook.
 *
 * The inbox handoff is deliberately consumed on both applied and replayed
 * deliveries. A crash after inbox persistence therefore resumes the same
 * capability-checked task transition without re-evaluating policy.
 */
export class SignalTaskComposition {
  private readonly transitions: TaskEffectTransitionCoordinator;

  constructor(
    private readonly dependencies: SignalTaskCompositionDependencies,
  ) {
    this.transitions = new TaskEffectTransitionCoordinator(
      dependencies.storage,
      dependencies.clock,
    );
  }

  async handleWebhook(
    input: VerifyGitHubWebhookInput,
  ): Promise<SignalTaskTransitionMetadata> {
    const receipt = await this.dependencies.webhookVerifier.verify(input);
    const envelope =
      await this.dependencies.webhookNormalizer.normalize(receipt);
    const recorded = await this.dependencies.inbox.recordAndEvaluate({
      envelope,
    });
    const handoff = recorded.record.handoff;
    const source = envelope.source;
    if (source.kind !== 'github-webhook') {
      throw new SignalTaskCompositionConflict('Webhook source disappeared');
    }
    assertSameNormalizedEnvelope(
      envelope,
      handoff.envelope,
      recorded.record.inputSha256,
    );
    const durableEnvelope = handoff.envelope;
    const durableSource = durableEnvelope.source;
    if (durableSource.kind !== 'github-webhook') {
      throw new SignalTaskCompositionConflict('Webhook source disappeared');
    }
    const activation = await this.dependencies.activation.resolve({
      envelope: durableEnvelope,
      policyDecision: handoff.policyDecision,
    });
    if (
      activation === undefined ||
      !sameTenantTask(activation, durableEnvelope) ||
      activation.mode === 'retired'
    ) {
      throw new SignalTaskCompositionConflict('Task activation is unavailable');
    }

    const candidate =
      durableEnvelope.signal.kind === 'requested-work'
        ? await this.dependencies.candidate.resolve({
            envelope: durableEnvelope,
            policyDecision: handoff.policyDecision,
          })
        : undefined;
    if (
      durableEnvelope.signal.kind === 'requested-work' &&
      candidate === undefined
    ) {
      throw new SignalTaskCompositionConflict(
        'Requested work has no server-owned intent candidate',
      );
    }

    const scope = taskScope(durableEnvelope);
    const transition = await this.dependencies.leases.run(
      scope,
      async (lease) => {
        const current = await this.dependencies.storage.readTask(scope);
        return this.transitions.apply({
          lease,
          expectedRevision: current?.revision ?? 0,
          envelope: durableEnvelope,
          policyDecision: handoff.policyDecision,
          activation,
          candidate,
        });
      },
    );
    return {
      delivery: {
        status: recorded.status,
        tenantId: recorded.record.tenantId,
        deliveryId: recorded.record.deliveryId,
        requestId: recorded.record.requestId,
        factId: recorded.record.factId,
        repositoryId: recorded.record.repositoryId,
      },
      transition: sanitizeTransition(transition),
    };
  }
}
