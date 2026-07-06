import { forceStructuredLogging, isOnGoogleCloud } from '@repo/env';

import { Logger } from './console-logger';
import { SlackLogger } from './slack-logger';

// Use the static resolver, which falls back to DEBUG when LOG_LEVEL is unset.
// Reading the raw env directly yields `undefined`, and shouldLog(undefined, …)
// is always false — silently dropping every log line (including errors) for any
// service that does not set LOG_LEVEL (e.g. the primes/onecake web apps).
export const logger = new Logger(Logger.getLogLevel(), {
  isOnGoogleCloud,
  forceStructuredLogging,
});
export const slackLogger = new SlackLogger(
  'slack:bolt',
  SlackLogger.getSlackLogLevel(),
);
export const slackClientLogger = new SlackLogger(
  'slack:client',
  SlackLogger.getSlackLogLevel(),
);

export const slackBotClientLogger = new SlackLogger(
  'slack:bot-client',
  SlackLogger.getSlackLogLevel(),
);
