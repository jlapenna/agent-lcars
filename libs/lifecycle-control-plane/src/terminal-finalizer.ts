import type { AgentResultClaimV1 } from '@agent-lcars/dispatch-contracts';

import type {
  AttemptState,
  ClaimedEvidence,
  FinalizationWindow,
} from './attempt-reducer';
import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import {
  finalizationCommandId,
  type FinalizationVerdict,
  isVerifiedFinalizationObservation,
  mintFinalizationTransition,
  TerminalFinalizerConflict,
  type VerifiedFinalizationObservation,
} from './finalization-capability';

export {
  ClaimObservationBoundary,
  isVerifiedClaimObservation,
  isVerifiedFinalizationObservation,
  isVerifiedTerminalObservation,
  TerminalFinalizerConflict,
  TerminalObservationBoundary,
  type TerminalRunAttestationVerifier,
  type VerifiedClaimObservation,
  type VerifiedFinalizationObservation,
  type VerifiedTerminalObservation,
} from './finalization-capability';

export interface EvidenceValidationSelection {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly spec: AttemptState['spec'];
  readonly specDigest: string;
  readonly terminalFactId: string;
  readonly terminalConclusion: FinalizationWindow['terminalConclusion'];
  readonly claimFactId: string;
  readonly claim: AgentResultClaimV1;
  readonly policyRevision: AttemptState['spec']['authorization']['policy'];
  readonly validationFactId: string;
  readonly validatedAt: string;
}

/**
 * A later adapter supplies provider lookup. A transient lookup throws and
 * leaves the claimed work unresolved; only definitive verdicts become facts.
 */
export interface EvidenceValidationResolver {
  resolve(selection: EvidenceValidationSelection): Promise<FinalizationVerdict>;
}

function frozenClone<T>(value: T): T {
  const freeze = (child: unknown): unknown => {
    if (child !== null && typeof child === 'object') {
      for (const value of Object.values(child)) freeze(value);
      Object.freeze(child);
    }
    return child;
  };
  return freeze(structuredClone(value)) as T;
}

function validationSelection(
  tenantId: string,
  state: AttemptState,
  evidence: ClaimedEvidence,
  validationFactId: string,
  validatedAt: string,
): EvidenceValidationSelection {
  const finalization = state.finalization;
  if (finalization === undefined) {
    throw new TerminalFinalizerConflict('Finalization window is absent');
  }
  return frozenClone({
    tenantId,
    attemptId: state.spec.attemptId,
    spec: state.spec,
    specDigest: state.specDigest,
    terminalFactId: finalization.terminalFactId,
    terminalConclusion: finalization.terminalConclusion,
    claimFactId: evidence.factId,
    claim: evidence.claim,
    policyRevision: state.spec.authorization.policy,
    validationFactId,
    validatedAt,
  });
}

/** Inactive provider-neutral coordinator; every durable write is re-derived. */
export class AttemptFinalizer {
  constructor(
    private readonly storage: LifecycleAuthorityStorage,
    private readonly clock: AuthorityClock,
    private readonly resolver: EvidenceValidationResolver,
  ) {}

  async recordObservation(
    lease: TaskAuthorityLease,
    verified: VerifiedFinalizationObservation,
  ): Promise<WriteResult> {
    if (!isVerifiedFinalizationObservation(verified)) {
      throw new TerminalFinalizerConflict(
        'Observation capability was not minted here',
      );
    }
    const transition = mintFinalizationTransition({
      kind: 'observation',
      tenantId: verified.envelope.tenant.tenantId,
      attemptId: verified.envelope.attemptId,
      at: this.clock.now(),
      observation: verified,
    });
    return this.storage.applyFinalizationTransition({ lease, transition });
  }

  async beginValidation(
    lease: TaskAuthorityLease,
    tenantId: string,
    attemptId: string,
  ): Promise<WriteResult> {
    const state = await this.read(tenantId, attemptId);
    const terminalFactId = state.finalization?.terminalFactId;
    if (terminalFactId === undefined) {
      throw new TerminalFinalizerConflict('Finalization window is absent');
    }
    const closesAt = state.finalization?.closesAt;
    if (
      closesAt === undefined ||
      Date.parse(this.clock.now()) < Date.parse(closesAt)
    ) {
      throw new TerminalFinalizerConflict('Validation window is still open');
    }
    const transition = mintFinalizationTransition({
      kind: 'start-validation',
      tenantId,
      attemptId,
      // The policy-owned boundary makes command replay byte-identical.
      at: closesAt,
    });
    return this.storage.applyFinalizationTransition({ lease, transition });
  }

  async resolveClaim(
    lease: TaskAuthorityLease,
    tenantId: string,
    attemptId: string,
    claimFactId: string,
  ): Promise<WriteResult> {
    let state = await this.read(tenantId, attemptId);
    const finalization = state.finalization;
    const evidence = finalization?.evidence.find(
      (candidate) => candidate.factId === claimFactId,
    );
    if (finalization === undefined || evidence === undefined) {
      throw new TerminalFinalizerConflict('Claim is not pending validation');
    }
    const validationFactId = finalizationCommandId(
      'validate-claim',
      attemptId,
      finalization.terminalFactId,
      claimFactId,
    );
    const priorValidation = evidence.validation;
    if (
      priorValidation?.status === 'validated' ||
      priorValidation?.status === 'rejected'
    ) {
      if (priorValidation.validationFactId !== validationFactId) {
        throw new TerminalFinalizerConflict('Claim validation conflicts');
      }
      let verdict: FinalizationVerdict;
      if (priorValidation.status === 'validated') {
        verdict = { status: 'validated' };
      } else {
        if (priorValidation.reason === 'lookup-failed') {
          throw new TerminalFinalizerConflict(
            'Transient lookup failure is not definitive evidence',
          );
        }
        verdict = { status: 'rejected', reason: priorValidation.reason };
      }
      const transition = mintFinalizationTransition({
        kind: 'validate-claim',
        tenantId,
        attemptId,
        claimFactId,
        validationFactId,
        at: priorValidation.validatedAt,
        verdict,
      });
      return this.storage.applyFinalizationTransition({ lease, transition });
    }
    if (state.phase !== 'validating') {
      throw new TerminalFinalizerConflict('Claim is not pending validation');
    }

    await this.storage.claimValidationWork({
      lease,
      tenantId,
      attemptId,
      terminalFactId: finalization.terminalFactId,
      claimFactId,
    });
    // The claim may have completed between the initial read and the claim.
    state = await this.read(tenantId, attemptId);
    const currentEvidence = state.finalization?.evidence.find(
      (candidate) => candidate.factId === claimFactId,
    );
    if (currentEvidence?.validation !== undefined) {
      return this.resolveClaim(lease, tenantId, attemptId, claimFactId);
    }
    if (currentEvidence === undefined) {
      throw new TerminalFinalizerConflict(
        'Claim disappeared during validation',
      );
    }

    const at = this.clock.now();
    const selection = validationSelection(
      tenantId,
      state,
      currentEvidence,
      validationFactId,
      at,
    );
    const verdict = await this.resolver.resolve(selection);
    if (
      verdict.status !== 'validated' &&
      !(
        verdict.status === 'rejected' &&
        ['marker-mismatch', 'reference-mismatch'].includes(verdict.reason)
      )
    ) {
      throw new TerminalFinalizerConflict(
        'Resolver returned an invalid verdict',
      );
    }
    const transition = mintFinalizationTransition({
      kind: 'validate-claim',
      tenantId,
      attemptId,
      claimFactId,
      validationFactId,
      at,
      verdict,
    });
    return this.storage.applyFinalizationTransition({ lease, transition });
  }

  async finalize(
    lease: TaskAuthorityLease,
    tenantId: string,
    attemptId: string,
  ): Promise<WriteResult> {
    const state = await this.read(tenantId, attemptId);
    const terminalFactId = state.finalization?.terminalFactId;
    if (terminalFactId === undefined) {
      throw new TerminalFinalizerConflict('Finalization window is absent');
    }
    const eventId = finalizationCommandId(
      'finalize',
      attemptId,
      terminalFactId,
    );
    const transition = mintFinalizationTransition({
      kind: 'finalize',
      tenantId,
      attemptId,
      eventId,
      at: state.outcome?.finalizedAt ?? this.clock.now(),
    });
    return this.storage.applyFinalizationTransition({ lease, transition });
  }

  private async read(
    tenantId: string,
    attemptId: string,
  ): Promise<AttemptState> {
    const state = await this.storage.readAttempt({ tenantId, attemptId });
    if (state === undefined) {
      throw new TerminalFinalizerConflict('Attempt is unknown');
    }
    return state;
  }
}
