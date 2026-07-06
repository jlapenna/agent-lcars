import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  forceStructuredLogging,
  getSlackLogLevel as getEnvSlackLogLevel,
  isOnGoogleCloud,
} from '@repo/env';
import rtracer from 'cls-rtracer';
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { formatWithOptions } from 'util';

import { setLogEnricher, setLogFormatter } from '../console-logger';
import {
  bindBoltContext,
  bindExpressContext,
  getContext,
  getTraceId,
  injectLoggingContext,
  RequestContext,
  runWithContext,
  traceMiddleware,
} from '../context';
import { LogLevel } from '../log-level';
import { shouldLog } from '../utils';

export {
  bindBoltContext,
  bindExpressContext,
  getContext,
  getTraceId,
  runWithContext,
  traceMiddleware,
};
export type { RequestContext };

const contextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Initialize Node.js specific logging context and tracing.
 */
export function initNodeLogging() {
  // Set log formatter to use Node's util.formatWithOptions
  setLogFormatter((args) => formatWithOptions({ depth: 5 }, ...args));

  // Inject context implementation
  injectLoggingContext(
    (context, callback) => contextStorage.run(context, callback),
    () => contextStorage.getStore(),
    (req: Request, res: Response, next: NextFunction) => {
      rtracer.expressMiddleware({
        useHeader: true,
        headerName: 'X-Cloud-Trace-Context',
        requestIdFactory: (req: Request) => {
          const traceHeader = req.headers['x-cloud-trace-context'];
          if (traceHeader && typeof traceHeader === 'string') {
            return traceHeader;
          }
          return crypto.randomUUID();
        },
      })(req, res, next);
    },
    () => rtracer.id() as string | undefined,
  );

  // Set log enricher for structured logging
  setLogEnricher(() => {
    const context = contextStorage.getStore();
    const traceId = getTraceId();
    return {
      traceId: typeof traceId === 'string' ? traceId : undefined,
      requestUrl: context?.path,
      userId: context?.userId,
      action: context?.action,
    };
  });
}

/**
 * A logger that pipes to console.log and applies log level filtering.
 */
export class SlackLogger {
  private level: LogLevel;

  constructor(
    private name: string,
    level: LogLevel,
  ) {
    this.level = level;
  }

  private log(severity: string, ...msg: unknown[]) {
    if (isOnGoogleCloud() || forceStructuredLogging()) {
      const message = formatWithOptions({ depth: null }, ...msg);
      const rawTraceId = getTraceId();
      const traceId = typeof rawTraceId === 'string' ? rawTraceId : undefined;
      const context = contextStorage.getStore();
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
      const logFn =
        severity in console
          ? (console[severity as keyof Console] as (...args: unknown[]) => void)
          : console.log;
      logFn(`[${this.name}]`, ...msg);
    }
  }

  debug(...msg: unknown[]) {
    if (shouldLog(this.level, LogLevel.DEBUG)) this.log('debug', ...msg);
  }
  info(...msg: unknown[]) {
    if (shouldLog(this.level, LogLevel.INFO)) this.log('info', ...msg);
  }
  warn(...msg: unknown[]) {
    if (shouldLog(this.level, LogLevel.WARN)) this.log('warn', ...msg);
  }
  error(...msg: unknown[]) {
    if (shouldLog(this.level, LogLevel.ERROR)) this.log('error', ...msg);
  }

  static getSlackLogLevel(): LogLevel {
    const level = getEnvSlackLogLevel()?.toLowerCase();
    const valid = [
      LogLevel.ERROR,
      LogLevel.WARN,
      LogLevel.INFO,
      LogLevel.DEBUG,
    ];
    return level && valid.includes(level as LogLevel)
      ? (level as LogLevel)
      : LogLevel.DEBUG;
  }
}
