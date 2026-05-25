import { LogLevel } from './log-level';
import { shouldLog } from './utils';

export interface LogEnrichment {
  traceId?: string;
  requestUrl?: string;
  userId?: string;
  action?: string;
}

export type LogEnricher = () => LogEnrichment;
export type LogFormatter = (args: unknown[]) => string;

let logEnricher: LogEnricher = () => ({});
let logFormatter: LogFormatter = (args: unknown[]) =>
  args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      return JSON.stringify(arg);
    })
    .join(' ');

let defaultLogLevelGetter: () => string | undefined = () =>
  typeof process !== 'undefined' ? process.env?.['LOG_LEVEL'] : undefined;

/**
 * Register a log enricher to add context to structured logs.
 */
export function setLogEnricher(enricher: LogEnricher) {
  logEnricher = enricher;
}

/**
 * Register a log formatter to customize how arguments are serialized.
 */
export function setLogFormatter(formatter: LogFormatter) {
  logFormatter = formatter;
}

/**
 * Configure default logging behavior.
 */
export function setLogDefaults(options: {
  getLogLevel?: () => string | undefined;
  formatter?: LogFormatter;
}) {
  if (options.getLogLevel) {
    defaultLogLevelGetter = options.getLogLevel;
  }
  if (options.formatter) {
    logFormatter = options.formatter;
  }
}

/**
 * A logger that wraps console methods and applies log level filtering.
 */
export class Logger {
  private level: LogLevel;

  private static readonly VALID_LEVELS = [
    LogLevel.ERROR,
    LogLevel.WARN,
    LogLevel.INFO,
    LogLevel.DEBUG,
  ];

  constructor(
    level: LogLevel,
    private options: {
      isOnGoogleCloud?: () => boolean;
      forceStructuredLogging?: () => boolean;
    } = {},
  ) {
    this.level = level;
  }

  /**
   * Get the default log level from environment variables.
   */
  static getLogLevel(): LogLevel {
    try {
      const level = defaultLogLevelGetter()?.toLowerCase();
      if (level && Logger.VALID_LEVELS.includes(level as LogLevel)) {
        return level as LogLevel;
      }
    } catch {
      // Ignore
    }

    return LogLevel.DEBUG;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private log(severity: string, ...args: unknown[]) {
    const isCloud = this.options.isOnGoogleCloud?.() ?? false;
    const isForced = this.options.forceStructuredLogging?.() ?? false;

    if (isCloud || isForced) {
      const message = logFormatter(args);
      const enrichment = logEnricher();
      console.log(
        JSON.stringify({
          severity: severity.toUpperCase(),
          message,
          ...(enrichment.traceId
            ? { 'logging.googleapis.com/trace': enrichment.traceId }
            : {}),
          ...(enrichment.requestUrl
            ? { httpRequest: { requestUrl: enrichment.requestUrl } }
            : {}),
          ...(enrichment.userId ? { userId: enrichment.userId } : {}),
          ...(enrichment.action ? { action: enrichment.action } : {}),
        }),
      );
    } else {
      switch (severity) {
        case LogLevel.DEBUG:
          console.debug(...args);
          break;
        case LogLevel.INFO:
          console.log(...args);
          break;
        case LogLevel.WARN:
          console.warn(...args);
          break;
        case LogLevel.ERROR:
          console.error(...args);
          break;
      }
    }
  }

  info(...args: unknown[]) {
    if (shouldLog(this.level, LogLevel.INFO)) {
      this.log(LogLevel.INFO, ...args);
    }
  }

  debug(...args: unknown[]) {
    if (shouldLog(this.level, LogLevel.DEBUG)) {
      this.log(LogLevel.DEBUG, ...args);
    }
  }

  warn(...args: unknown[]) {
    if (shouldLog(this.level, LogLevel.WARN)) {
      this.log(LogLevel.WARN, ...args);
    }
  }

  error(...args: unknown[]) {
    if (shouldLog(this.level, LogLevel.ERROR)) {
      this.log(LogLevel.ERROR, ...args);
    }
  }
}
