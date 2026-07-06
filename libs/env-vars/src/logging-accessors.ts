import { isTrue, optional } from './env-util';

/**
 * Dependency-free home for the handful of env accessors `@repo/logging`
 * needs. `@repo/logging` can't depend on `@repo/util-server` (which already
 * depends on `@repo/logging`), so these used to be hand-copied byte-for-byte
 * into `libs/logging/src/env.ts` (#2129). `@repo/util-server` re-exports the
 * same functions so external behavior is unchanged.
 */
export function isOnGoogleCloud(): boolean {
  // https://cloud.google.com/run/docs/container-contract#env-vars
  return (
    (optional('K_SERVICE') !== undefined ||
      optional('K_REVISION') !== undefined ||
      optional('CLOUD_RUN_JOB') !== undefined) &&
    !isTrue('FUNCTIONS_EMULATOR')
  );
}

export function forceStructuredLogging(): boolean {
  return isTrue('FORCE_STRUCTURED_LOGGING');
}

export const getLogLevel = () => optional('LOG_LEVEL');

export const getSlackLogLevel = () => optional('SLACK_LOG_LEVEL');
