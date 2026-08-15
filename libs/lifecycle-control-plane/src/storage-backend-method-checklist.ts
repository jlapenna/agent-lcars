/**
 * Compile-time checklist for test-only storage contract adapters. This module
 * intentionally stays outside the production barrel while remaining in the
 * library TypeScript program, so port additions fail compilation until the
 * aggregate contract is updated deliberately.
 */
import type { LifecycleAuthorityStorage } from './authority-storage';

export const lifecycleAuthorityStorageMethodChecklist = {
  acquireTaskLease: true,
  renewTaskLease: true,
  releaseTaskLease: true,
  registerActivation: true,
  mayWriteEffects: true,
  applyTaskEffectTransition: true,
  readTaskPresentation: true,
  listTaskPresentations: true,
  readAttemptPresentation: true,
  listAttemptPresentations: true,
  readPresentationDelivery: true,
  listPresentationDelivery: true,
  claimPresentationDelivery: true,
  resolveVerifiedPresentationDelivery: true,
  listTaskEffects: true,
  readTaskEffect: true,
  claimTaskEffect: true,
  completeTaskEffect: true,
  obsoleteTaskEffect: true,
  applyVerifiedCancellationEffect: true,
  readCancellationReceipt: true,
  listCancellationWork: true,
  admitVerifiedAttemptAndRecordLaunch: true,
  readAttemptAdmission: true,
  readTask: true,
  readAttempt: true,
  applyFinalizationTransition: true,
  listValidationWork: true,
  claimValidationWork: true,
  readLaunch: true,
  listLaunches: true,
  claimLaunchWork: true,
  resolveVerifiedLaunch: true,
  rejectVerifiedLaunch: true,
  recordObservation: true,
  recordBindingObservationAndResolveLaunch: true,
  lookupOrReserveMint: true,
  resolveMint: true,
  resolveVerifiedMint: true,
  readMint: true,
} satisfies Record<keyof LifecycleAuthorityStorage, true>;

export type LifecycleAuthorityStorageMethodChecklist =
  typeof lifecycleAuthorityStorageMethodChecklist;

export function assertLifecycleAuthorityStorageMethodChecklist<
  T extends LifecycleAuthorityStorage,
>(): void {
  const _value = undefined as unknown as T;
  void _value;
}
