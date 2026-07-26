/** Handle special cases in env dotfiles. */

import { isOnGoogleCloud, isTrue, optional, required } from '@repo/env';

export { isOnGoogleCloud, optional, required };

export const isE2eTesting = () => isTrue('E2E_TESTING');

export const isFunctionsEmulator = () => isTrue('FUNCTIONS_EMULATOR');

export const isEmulator = () =>
  isFunctionsEmulator() ||
  getAuthEmulatorHost() ||
  getFirebaseAuthEmulatorHost() ||
  getFirestoreEmulatorHost();

export const getAuthEmulatorHost = () => optional('AUTH_EMULATOR_HOST');

export const getFirebaseAuthEmulatorHost = () =>
  optional('FIREBASE_AUTH_EMULATOR_HOST');

export const getFirestoreEmulatorHost = () =>
  optional('FIRESTORE_EMULATOR_HOST');

export const getProjectId = () => {
  return (
    optional('PROJECT_ID') ||
    optional('GCLOUD_PROJECT') ||
    optional('FIREBASE_PROJECT_ID') ||
    required('PROJECT_ID')
  );
};
