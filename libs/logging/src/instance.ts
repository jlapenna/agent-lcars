import { forceStructuredLogging, isOnGoogleCloud } from '@agent-lcars/env';
import { Logger } from '@jlapenna/fleet-runtime/logging';

// Use the static resolver, which falls back to DEBUG when LOG_LEVEL is unset.
// Reading the raw env directly yields `undefined`, and shouldLog(undefined, …)
// is always false — silently dropping every log line (including errors) for any
// service that does not set LOG_LEVEL (e.g. the primes/onecake web apps).
export const logger = new Logger(Logger.getLogLevel(), {
  isOnGoogleCloud,
  forceStructuredLogging,
});
