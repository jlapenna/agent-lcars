import 'server-only';

import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityScope,
  WriteResult,
} from './authority-storage';
import type { TaskLeaseRunner } from './signal-task-composition';
import {
  AttemptFinalizer,
  ClaimObservationBoundary,
  type EvidenceValidationResolver,
  TerminalObservationBoundary,
  type TerminalRunAttestationVerifier,
} from './terminal-finalizer';

/** Dependencies owned by the inactive server-side attempt finalizer. */
export interface AttemptFinalizationCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  verifier: TerminalRunAttestationVerifier;
  resolver: EvidenceValidationResolver;
  clock: AuthorityClock;
  leases: TaskLeaseRunner;
}

export interface AttemptFinalizationIdentity {
  tenantId: string;
  attemptId: string;
}

export interface ResolveClaimInput extends AttemptFinalizationIdentity {
  claimFactId: string;
}

export class AttemptFinalizationCompositionConflict extends Error {
  override name = 'AttemptFinalizationCompositionConflict';
}

const ATTEMPT_ID = /^[A-Za-z0-9_-]{22,64}$/u;

function taskScope(
  task: TaskAuthorityScope,
  tenantId: string,
): TaskAuthorityScope {
  if (
    task.tenantId !== tenantId ||
    !Number.isSafeInteger(task.repositoryId) ||
    task.repositoryId <= 0 ||
    !Number.isSafeInteger(task.issueNumber) ||
    task.issueNumber <= 0
  ) {
    throw new AttemptFinalizationCompositionConflict(
      'Attempt task scope is invalid or crosses tenant scope',
    );
  }
  return {
    tenantId,
    repositoryId: task.repositoryId,
    issueNumber: task.issueNumber,
  };
}

function validateIdentity(input: AttemptFinalizationIdentity): void {
  if (
    typeof input.tenantId !== 'string' ||
    input.tenantId.length === 0 ||
    !ATTEMPT_ID.test(input.attemptId)
  ) {
    throw new AttemptFinalizationCompositionConflict(
      'Attempt identity is invalid',
    );
  }
}

/**
 * Inactive server-owned coordinator for terminal observations and attempt
 * finalization. Callers provide no lease or capability; both are derived from
 * authenticated observations or durable attempt identity.
 */
export class AttemptFinalizationComposition {
  private readonly terminalBoundary: TerminalObservationBoundary;
  private readonly claimBoundary: ClaimObservationBoundary;
  private readonly finalizer: AttemptFinalizer;

  constructor(
    private readonly dependencies: AttemptFinalizationCompositionDependencies,
  ) {
    this.terminalBoundary = new TerminalObservationBoundary(
      dependencies.verifier,
    );
    this.claimBoundary = new ClaimObservationBoundary(dependencies.verifier);
    this.finalizer = new AttemptFinalizer(
      dependencies.storage,
      dependencies.clock,
      dependencies.resolver,
    );
  }

  async recordTerminal(input: { envelope: unknown }): Promise<WriteResult> {
    const verified = await this.terminalBoundary.verify(input);
    const scope = taskScope(
      {
        tenantId: verified.envelope.task.tenantId,
        repositoryId: verified.envelope.task.repositoryId,
        issueNumber: verified.envelope.task.issueNumber,
      },
      verified.envelope.tenant.tenantId,
    );
    return this.dependencies.leases.run(scope, (lease) =>
      this.finalizer.recordObservation(lease, verified),
    );
  }

  async recordClaim(input: { envelope: unknown }): Promise<WriteResult> {
    const verified = await this.claimBoundary.parse(input);
    const scope = taskScope(
      {
        tenantId: verified.envelope.task.tenantId,
        repositoryId: verified.envelope.task.repositoryId,
        issueNumber: verified.envelope.task.issueNumber,
      },
      verified.envelope.tenant.tenantId,
    );
    return this.dependencies.leases.run(scope, (lease) =>
      this.finalizer.recordObservation(lease, verified),
    );
  }

  async beginValidation(
    input: AttemptFinalizationIdentity,
  ): Promise<WriteResult> {
    const { tenantId, attemptId, task } = await this.readIdentity(input);
    return this.dependencies.leases.run(task, (lease) =>
      this.finalizer.beginValidation(lease, tenantId, attemptId),
    );
  }

  async resolveClaim(input: ResolveClaimInput): Promise<WriteResult> {
    const { tenantId, attemptId, task } = await this.readIdentity(input);
    return this.dependencies.leases.run(task, (lease) =>
      this.finalizer.resolveClaim(
        lease,
        tenantId,
        attemptId,
        input.claimFactId,
      ),
    );
  }

  async finalize(input: AttemptFinalizationIdentity): Promise<WriteResult> {
    const { tenantId, attemptId, task } = await this.readIdentity(input);
    return this.dependencies.leases.run(task, (lease) =>
      this.finalizer.finalize(lease, tenantId, attemptId),
    );
  }

  private async readIdentity(input: AttemptFinalizationIdentity): Promise<{
    tenantId: string;
    attemptId: string;
    task: TaskAuthorityScope;
  }> {
    validateIdentity(input);
    const attempt = await this.dependencies.storage.readAttempt({
      tenantId: input.tenantId,
      attemptId: input.attemptId,
    });
    if (attempt === undefined) {
      throw new AttemptFinalizationCompositionConflict('Attempt is unknown');
    }
    return {
      tenantId: input.tenantId,
      attemptId: input.attemptId,
      task: taskScope(attempt.spec.task, input.tenantId),
    };
  }
}
