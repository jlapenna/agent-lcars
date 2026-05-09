import { LogLevel } from './log-level';

/**
 * Check if a message at the given level should be logged based on the current level.
 * @param currentLevel The current log level threshold
 * @param messageLevel The level of the message to be logged
 * @returns true if the message should be logged, false otherwise
 */
export function shouldLog(
  currentLevel: LogLevel,
  messageLevel: LogLevel,
): boolean {
  const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG];
  const currentLevelIndex = levels.indexOf(currentLevel);
  const messageLevelIndex = levels.indexOf(messageLevel);
  // Log if message level is equal or higher priority than current level
  return messageLevelIndex <= currentLevelIndex;
}
