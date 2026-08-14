import 'server-only';

import type {
  LifecycleAuthorityStorage,
  TaskAuthorityScope,
  WriteResult,
} from './authority-storage';
import { ingestVerifiedRunBinding } from './launch-binding';
import { RunBindingIngressVerifier } from './run-binding-ingress';
import type { TaskLeaseRunner } from './signal-task-composition';

/** Dependencies owned by the inactive server-side run-binding ingress. */
export interface RunBindingIngressCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  verifier: RunBindingIngressVerifier;
  leases: TaskLeaseRunner;
}

/**
 * Untrusted values accepted at the composition boundary. The caller cannot
 * select a lease scope, expected attempt revision, binding, or next state.
 */
export interface RunBindingIngressCompositionInput {
  envelope: unknown;
  localAttemptMarker: unknown;
}

/**
 * Server-owned composition for one exact run-binding observation.
 *
 * Verification deliberately happens before lease acquisition. The verifier
 * mints the opaque capability, whose task identity is then the sole source of
 * lease scope. Storage owns the atomic observation/attempt/outbox handoff;
 * this composition returns only its existing durable write result.
 */
export class RunBindingIngressComposition {
  constructor(
    private readonly dependencies: RunBindingIngressCompositionDependencies,
  ) {}

  async ingest(input: RunBindingIngressCompositionInput): Promise<WriteResult> {
    const verified = await this.dependencies.verifier.verify(input);
    const scope: TaskAuthorityScope = {
      tenantId: verified.envelope.task.tenantId,
      repositoryId: verified.envelope.task.repositoryId,
      issueNumber: verified.envelope.task.issueNumber,
    };

    return this.dependencies.leases.run(scope, (lease) =>
      ingestVerifiedRunBinding(this.dependencies.storage, lease, verified),
    );
  }
}
