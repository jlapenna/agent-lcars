import { isTrue, optional } from './env-util';

/**
 * Dependency-free home for the handful of env accessors `@agent-lcars/logging`
 * needs. `@agent-lcars/logging` can't depend on `@agent-lcars/util-server` (which already
 * depends on `@agent-lcars/logging`), so these used to be hand-copied byte-for-byte
 * into `libs/logging/src/env.ts` (#2129). `@agent-lcars/util-server` re-exports the
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
