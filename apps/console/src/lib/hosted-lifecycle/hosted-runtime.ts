import 'server-only';

import {
  AttemptFinalizationComposition,
  type AttemptFinalizationCompositionDependencies,
  type AuthorityClock,
  CancellationTaskEffectComposition,
  createCredentialGrantComposition,
  type CredentialGrantCompositionDependencies,
  LaunchOutboxComposition,
  type LaunchOutboxCompositionDependencies,
  type LifecycleAuthorityStorage,
  PresentationDeliveryComposition,
  type PresentationDeliveryCompositionDependencies,
  RunBindingIngressComposition,
  type RunBindingIngressCompositionDependencies,
  SignalTaskComposition,
  type SignalTaskCompositionDependencies,
  TaskAdmissionEffectComposition,
  type TaskAdmissionEffectCompositionDependencies,
  type TaskLeaseRunner,
} from '@agent-lcars/lifecycle-control-plane';

/** The seams required by the authenticated signal composition. */
export type HostedSignalDependencies = Omit<
  SignalTaskCompositionDependencies,
  'clock' | 'leases' | 'storage'
>;

/** The seams required by the durable admission-effect worker. */
export type HostedAdmissionDependencies = Pick<
  TaskAdmissionEffectCompositionDependencies,
  'plans'
>;

/** The provider-neutral launch response boundary. */
export type HostedLaunchDependencies = Pick<
  LaunchOutboxCompositionDependencies,
  'responses'
>;

/** The verifier for one exact run-binding observation. */
export type HostedRunBindingDependencies = Pick<
  RunBindingIngressCompositionDependencies,
  'verifier'
>;

/** No composition-specific seams are required for cancellation. */
export type HostedCancellationDependencies = Record<never, never>;

/** The attestation and evidence seams for terminal finalization. */
export type HostedFinalizationDependencies = Pick<
  AttemptFinalizationCompositionDependencies,
  'resolver' | 'verifier'
>;

/** The provider-neutral presentation receiver. */
export type HostedPresentationDependencies = Pick<
  PresentationDeliveryCompositionDependencies,
  'receiver'
>;

/** The OIDC, tenant, and credential-minter seams for CredentialGrant. */
export type HostedGrantDependencies = Omit<
  CredentialGrantCompositionDependencies,
  'clock' | 'storage'
>;

/**
 * Server-owned seams for the inactive hosted lifecycle runtime.
 *
 * The common authority seams are deliberately selected once. Per-operation
 * groups contain only the trusted boundary needed by that composition; this
 * prevents a route from selecting a provider, tenant, policy, or lease.
 */
export interface HostedLifecycleRuntimeDependencies {
  readonly storage: LifecycleAuthorityStorage;
  readonly leases: TaskLeaseRunner;
  readonly clock: AuthorityClock;
  readonly signals: HostedSignalDependencies;
  readonly admissionEffects: HostedAdmissionDependencies;
  readonly launchOutbox: HostedLaunchDependencies;
  readonly runBinding: HostedRunBindingDependencies;
  readonly cancellationEffects?: HostedCancellationDependencies;
  readonly finalization: HostedFinalizationDependencies;
  readonly presentation: HostedPresentationDependencies;
  readonly credentialGrant: HostedGrantDependencies;
}

export interface HostedLifecycleRuntime {
  readonly signals: Readonly<{
    handleWebhook: SignalTaskComposition['handleWebhook'];
  }>;
  readonly admissionEffects: Readonly<{
    reconcile: TaskAdmissionEffectComposition['reconcile'];
  }>;
  readonly launchOutbox: Readonly<{
    reconcile: LaunchOutboxComposition['reconcile'];
  }>;
  readonly runBinding: Readonly<{
    ingest: RunBindingIngressComposition['ingest'];
  }>;
  readonly cancellationEffects: Readonly<{
    reconcile: CancellationTaskEffectComposition['reconcile'];
  }>;
  readonly finalization: Readonly<{
    recordTerminal: AttemptFinalizationComposition['recordTerminal'];
    recordClaim: AttemptFinalizationComposition['recordClaim'];
    beginValidation: AttemptFinalizationComposition['beginValidation'];
    resolveClaim: AttemptFinalizationComposition['resolveClaim'];
    finalize: AttemptFinalizationComposition['finalize'];
  }>;
  readonly presentation: Readonly<{
    deliver: PresentationDeliveryComposition['deliver'];
  }>;
  readonly credentialGrant: Readonly<{
    handle: ReturnType<typeof createCredentialGrantComposition>['handle'];
  }>;
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function')
  ) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function freezeReceipt<T>(value: T): T {
  // A Response owns a stream and cannot be cloned/frozen without changing
  // the transport contract. All other composition receipts are plain data.
  if (value instanceof Response) return value;
  return deepFreeze(structuredClone(value));
}

/**
 * Compose the eight inactive, server-owned lifecycle operations.
 *
 * The returned value is intentionally an operation-only facade. Composition
 * instances, storage, lease runners, clocks, and provider boundaries remain
 * private to the closures below and are never returned to route code.
 */
export function createHostedLifecycleRuntime(
  dependencies: HostedLifecycleRuntimeDependencies,
): HostedLifecycleRuntime {
  const signals = new SignalTaskComposition({
    ...dependencies.signals,
    clock: dependencies.clock,
    leases: dependencies.leases,
    storage: dependencies.storage,
  });
  const admission = new TaskAdmissionEffectComposition({
    leases: dependencies.leases,
    plans: dependencies.admissionEffects.plans,
    storage: dependencies.storage,
  });
  const launch = new LaunchOutboxComposition({
    clock: dependencies.clock,
    leases: dependencies.leases,
    responses: dependencies.launchOutbox.responses,
    storage: dependencies.storage,
  });
  const runBinding = new RunBindingIngressComposition({
    leases: dependencies.leases,
    storage: dependencies.storage,
    verifier: dependencies.runBinding.verifier,
  });
  const cancellation = new CancellationTaskEffectComposition({
    clock: dependencies.clock,
    leases: dependencies.leases,
    storage: dependencies.storage,
  });
  const finalization = new AttemptFinalizationComposition({
    clock: dependencies.clock,
    leases: dependencies.leases,
    resolver: dependencies.finalization.resolver,
    storage: dependencies.storage,
    verifier: dependencies.finalization.verifier,
  });
  const presentation = new PresentationDeliveryComposition({
    clock: dependencies.clock,
    leases: dependencies.leases,
    receiver: dependencies.presentation.receiver,
    storage: dependencies.storage,
  });
  const grant = createCredentialGrantComposition({
    ...dependencies.credentialGrant,
    clock: dependencies.clock,
    storage: dependencies.storage,
  });

  return deepFreeze({
    signals: {
      handleWebhook: (input: Parameters<typeof signals.handleWebhook>[0]) =>
        signals.handleWebhook(input).then(freezeReceipt),
    },
    admissionEffects: {
      reconcile: (input: Parameters<typeof admission.reconcile>[0]) =>
        admission.reconcile(input).then(freezeReceipt),
    },
    launchOutbox: {
      reconcile: (input: Parameters<typeof launch.reconcile>[0]) =>
        launch.reconcile(input).then(freezeReceipt),
    },
    runBinding: {
      ingest: (input: Parameters<typeof runBinding.ingest>[0]) =>
        runBinding.ingest(input).then(freezeReceipt),
    },
    cancellationEffects: {
      reconcile: (input: Parameters<typeof cancellation.reconcile>[0]) =>
        cancellation.reconcile(input).then(freezeReceipt),
    },
    finalization: {
      recordTerminal: (
        input: Parameters<typeof finalization.recordTerminal>[0],
      ) => finalization.recordTerminal(input).then(freezeReceipt),
      recordClaim: (input: Parameters<typeof finalization.recordClaim>[0]) =>
        finalization.recordClaim(input).then(freezeReceipt),
      beginValidation: (
        input: Parameters<typeof finalization.beginValidation>[0],
      ) => finalization.beginValidation(input).then(freezeReceipt),
      resolveClaim: (input: Parameters<typeof finalization.resolveClaim>[0]) =>
        finalization.resolveClaim(input).then(freezeReceipt),
      finalize: (input: Parameters<typeof finalization.finalize>[0]) =>
        finalization.finalize(input).then(freezeReceipt),
    },
    presentation: {
      deliver: (input: Parameters<typeof presentation.deliver>[0]) =>
        presentation.deliver(input).then(freezeReceipt),
    },
    credentialGrant: {
      handle: (input: Parameters<typeof grant.handle>[0]) =>
        grant.handle(input).then(freezeReceipt),
    },
  });
}
