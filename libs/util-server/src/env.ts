/** Handle special cases in env dotfiles. */

import { isOnGoogleCloud, isTrue, optional, required } from '@agent-lcars/env';

export { isOnGoogleCloud, optional, required };

export const isE2eTesting = () => isTrue('E2E_TESTING');

export const isEmulator = () => getFirestoreEmulatorHost();

export const getFirestoreEmulatorHost = () =>
  optional('FIRESTORE_EMULATOR_HOST');

export const getProjectId = () => {
  return (
    optional('PROJECT_ID') ||
    optional('GCLOUD_PROJECT') ||
    required('PROJECT_ID')
  );
};
