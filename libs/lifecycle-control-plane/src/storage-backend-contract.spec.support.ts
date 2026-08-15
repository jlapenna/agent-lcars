/**
 * Test-only backend contract surface. This file is intentionally not exported
 * from the lifecycle-control-plane production barrel and must not be imported
 * by runtime code.
 */
import type { AttemptState } from './attempt-reducer';
import type {
  AttemptIdFactory,
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import { runLifecycleAuthorityStorageContract } from './authority-storage.spec.support';
import type {
  IngressPolicyInbox,
  PolicyEvidenceResolver,
} from './ingress-policy';
import { runIngressPolicyInboxContract } from './ingress-policy.spec.support';
import { runVerifiedRunBindingStorageContract } from './launch-binding.spec.support';
import type { BindingHistoryStorageHooks } from './launch-binding-history-test-support';
import type { LaunchResolutionHistoryStorageHooks } from './launch-resolution.spec.support';
import {
  runLaunchResolutionHistoryStorageContract,
  runLaunchResolutionStorageContract,
} from './launch-resolution.spec.support';
import type { PresentationDeliveryStorageHooks } from './presentation-delivery.spec.support';
import { runPresentationDeliveryStorageContract } from './presentation-delivery.spec.support';
import {
  type AttemptAdmissionHistoryStorageHooks,
  runTaskAttemptAdmissionStorageContract,
} from './task-attempt-admission.spec.support';
import type { CancellationHistoryStorageHooks } from './task-effects.spec.support';
import {
  runCancellationEffectStorageContract,
  runCancellationHistoryStorageContract,
  runTaskEffectStorageContract,
  runTaskPresentationStorageContract,
} from './task-effects.spec.support';
import type { TerminalClaimHistoryStorageHooks } from './terminal-claim-history.in-memory.spec.support';
import { runAttemptFinalizerStorageContract } from './terminal-finalizer.spec.support';

/** A durable adapter's test factory may control trusted time and IDs. */
export interface LifecycleAuthorityBackendFactory {
  create(
    clock: AuthorityClock,
    attemptIds: AttemptIdFactory,
  ): LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>;
  hydrateAttempt(input: {
    storage: LifecycleAuthorityStorage;
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: AttemptState;
  }): Promise<WriteResult>;
  presentation: PresentationDeliveryStorageHooks;
  createInbox(
    clock: AuthorityClock & { set(value: string): void },
    evidenceResolver: PolicyEvidenceResolver,
  ): IngressPolicyInbox | Promise<IngressPolicyInbox>;
  admissionHistory: AttemptAdmissionHistoryStorageHooks;
  bindingHistory: BindingHistoryStorageHooks;
  launchResolutionHistory: LaunchResolutionHistoryStorageHooks;
  cancellationHistory: CancellationHistoryStorageHooks;
  terminalClaimHistory: TerminalClaimHistoryStorageHooks;
}
/**
 * Stable aggregate entrypoint for every provider-neutral storage contract.
 */
export function runLifecycleAuthorityBackendContract(
  factory: LifecycleAuthorityBackendFactory,
): void {
  let nextAttempt = 0;
  const mintUniqueAttemptId = (): string => {
    const suffix = (nextAttempt++).toString(36).padStart(21, '0');
    return `A${suffix}`;
  };
  const create = (clock: AuthorityClock) =>
    factory.create(clock, {
      mint: () => {
        return mintUniqueAttemptId();
      },
    });
  runLifecycleAuthorityStorageContract(create);
  runTaskEffectStorageContract({ create });
  runTaskPresentationStorageContract({ create });
  runCancellationEffectStorageContract({
    create,
    hydrateAttempt: factory.hydrateAttempt,
  });
  runCancellationHistoryStorageContract({
    create,
    hydrateAttempt: factory.hydrateAttempt,
    historyHooks: factory.cancellationHistory,
  });
  runTaskAttemptAdmissionStorageContract(
    (clock, attemptIds) => factory.create(clock, attemptIds),
    factory.admissionHistory,
  );
  runLaunchResolutionStorageContract({ create });
  runLaunchResolutionHistoryStorageContract({
    create,
    historyHooks: factory.launchResolutionHistory,
  });
  runVerifiedRunBindingStorageContract(
    () => create({ now: () => '2026-08-01T00:00:00.000Z' }),
    factory.bindingHistory,
  );
  runAttemptFinalizerStorageContract(
    (clock) => factory.create(clock, { mint: () => 'A'.repeat(22) }),
    factory.terminalClaimHistory,
  );
  runPresentationDeliveryStorageContract({ create, ...factory.presentation });
  runIngressPolicyInboxContract((clock, evidenceResolver) =>
    factory.createInbox(clock, evidenceResolver),
  );
}
