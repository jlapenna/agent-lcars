import rtracer from 'cls-rtracer';
import { formatWithOptions } from 'util';

import { getContext } from './context';
import {
  forceStructuredLogging,
  getSlackLogLevel,
  isOnGoogleCloud,
} from './env';
import { LogLevel } from './log-level';
import { shouldLog } from './utils';

/**
 * A logger that pipes to console.log and applies log level filtering.
 * It uses log levels to determine whether a message should be logged.
 */
export class SlackLogger {
  private name: string;
  private level: LogLevel;

  private static readonly VALID_LEVELS = [
    LogLevel.ERROR,
    LogLevel.WARN,
    LogLevel.INFO,
    LogLevel.DEBUG,
  ];

  constructor(name: string, level: LogLevel) {
    this.name = name;
    this.level = level;
  }

  private log(severity: string, ...msg: unknown[]) {
    if (isOnGoogleCloud() || forceStructuredLogging()) {
      const message = formatWithOptions({ depth: null }, ...msg);
      const traceId = rtracer.id();
      const context = getContext();
      console.log(
        JSON.stringify({
          severity: severity.toUpperCase(),
          message: `[${this.name}] ${message}`,
          ...(traceId ? { 'logging.googleapis.com/trace': traceId } : {}),
          ...(context?.path
            ? { httpRequest: { requestUrl: context.path } }
            : {}),
          ...(context?.userId ? { userId: context.userId } : {}),
          ...(context?.action ? { action: context.action } : {}),
        }),
      );
    } else {
      switch (severity) {
        case LogLevel.DEBUG:
          console.debug(`[${this.name}]`, ...msg);
          break;
        case LogLevel.INFO:
          console.info(`[${this.name}]`, ...msg);
          break;
        case LogLevel.WARN:
          console.warn(`[${this.name}]`, ...msg);
          break;
        case LogLevel.ERROR:
          console.error(`[${this.name}]`, ...msg);
          break;
      }
    }
  }

  debug(...msg: unknown[]) {
    if (shouldLog(this.level, LogLevel.DEBUG)) {
      this.log(LogLevel.DEBUG, ...msg);
    }
  }

  info(...msg: unknown[]) {
    if (shouldLog(this.level, LogLevel.INFO)) {
      this.log(LogLevel.INFO, ...msg);
    }
  }

  warn(...msg: unknown[]) {
    if (shouldLog(this.level, LogLevel.WARN)) {
      this.log(LogLevel.WARN, ...msg);
    }
  }

  error(...msg: unknown[]) {
    if (shouldLog(this.level, LogLevel.ERROR)) {
      this.log(LogLevel.ERROR, ...msg);
    }
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  getLevel() {
    return this.level;
  }

  setName(name: string) {
    this.name = name;
  }

  /**
   * Get the Slack log level from environment variables.
   * Defaults to DEBUG if not set or invalid.
   */
  static getSlackLogLevel(): LogLevel {
    const level = getSlackLogLevel()?.toLowerCase();

    if (level && SlackLogger.VALID_LEVELS.includes(level as LogLevel)) {
      return level as LogLevel;
    }

    return LogLevel.DEBUG;
  }
}
