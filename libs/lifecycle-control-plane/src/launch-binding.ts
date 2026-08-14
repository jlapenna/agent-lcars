import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import {
  isVerifiedRunBindingIngress,
  RunBindingIngressConflict,
  type VerifiedRunBindingIngress,
} from './run-binding-ingress';

export {
  RunBindingIngressConflict,
  RunBindingIngressVerifier,
  type TrustedRunBindingVerifier,
  type VerifiedRunBindingIngress,
} from './run-binding-ingress';

/**
 * Inactive exact-binding handoff: no provider effect, endpoint, or
 * credential. Storage independently derives/revalidates identities and the
 * reducer result before changing any durable index.
 */
export async function ingestVerifiedRunBinding(
  storage: LifecycleAuthorityStorage,
  lease: TaskAuthorityLease,
  verified: VerifiedRunBindingIngress,
): Promise<WriteResult> {
  if (!isVerifiedRunBindingIngress(verified)) {
    throw new RunBindingIngressConflict(
      'Run-binding capability was not minted here',
    );
  }
  const { envelope, localAttemptMarker } = verified;
  const attempt = await storage.readAttempt({
    tenantId: envelope.tenant.tenantId,
    attemptId: envelope.attemptId,
  });
  if (attempt === undefined) {
    throw new RunBindingIngressConflict('Unknown tenant-scoped attempt');
  }
  if (attempt.spec.local.attemptMarker !== localAttemptMarker) {
    throw new RunBindingIngressConflict(
      'Run-binding local marker does not match attempt',
    );
  }
  return storage.recordBindingObservationAndResolveLaunch({
    lease,
    verified,
    expectedAttemptRevision: attempt.revision,
  });
}
