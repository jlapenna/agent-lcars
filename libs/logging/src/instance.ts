import { Logger } from './console-logger';
import { forceStructuredLogging, getLogLevel, isOnGoogleCloud } from './env';
import { LogLevel } from './log-level';
import { SlackLogger } from './slack-logger';

export const logger = new Logger(getLogLevel() as LogLevel, {
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
