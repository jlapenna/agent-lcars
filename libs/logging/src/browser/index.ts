/// <reference lib="dom" />
function getNextPublicProjectId() {
  return process.env.NEXT_PUBLIC_PROJECT_ID;
}
import { Logger } from '../console-logger';
import { LogLevel } from '../log-level';
import { shouldLog } from '../utils';

declare global {
  interface Window {
    GCP_TRACE_ID?: string;
  }
}

export * from '../console-logger';
export * from '../log-level';
export * from '../utils';

// Global lock to prevent infinite recursion if fetch itself throws an error
let isSendingError = false;

// Simple circular-safe serializer
function safeStringify(obj: unknown): string {
  const cache = new Set();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (cache.has(value)) {
        return '[Circular]';
      }
      cache.add(value);
    }
    return value;
  });
}

// Simple rate limiter to prevent spamming identical errors
const recentErrors = new Set<string>();
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'test') {
  setInterval(() => recentErrors.clear(), 10000); // Clear every 10 seconds
}

class BrowserLogger extends Logger {
  override error(...args: unknown[]) {
    // 1. Still print to the local browser console normally
    super.error(...args);

    // 2. Check if we should actually log this level
    if (!shouldLog(this.getLevel(), LogLevel.ERROR)) {
      return;
    }

    // 3. Prevent infinite recursion
    if (isSendingError) {
      return;
    }

    // 4. Fire-and-forget proxy the error up to GCP
    try {
      const err = args.find((arg): arg is Error => arg instanceof Error);
      const message = args
        .map((a) =>
          typeof a === 'string'
            ? a
            : a instanceof Error
              ? a.stack || a.message
              : safeStringify(a),
        )
        .join(' ')
        .substring(0, 2048); // 5. Limit payload size

      // 6. Rate Limit idential payloads
      const errorHash = `${message}-${err?.stack || ''}`;
      if (recentErrors.has(errorHash)) {
        return;
      }
      recentErrors.add(errorHash);

      const payload = {
        source: 'browser_logger',
        message: message || 'Unknown Browser Error',
        stack: err?.stack || new Error().stack,
        url: typeof window !== 'undefined' ? window.location.href : '',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        traceId:
          typeof window !== 'undefined' &&
          typeof window.GCP_TRACE_ID === 'string'
            ? window.GCP_TRACE_ID
            : undefined,
        projectId: getNextPublicProjectId(),
      };

      isSendingError = true;
      fetch('/api/logs/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true, // Try to guarantee delivery if navigating away
      })
        .catch(() => {
          // Silently fail to prevent recursion or console spam
        })
        .finally(() => {
          isSendingError = false;
        });
    } catch {
      // Ignore serialization errors
    }
  }
}

// Client-safe logger instance that intercepts errors for tracking
export const logger = new BrowserLogger(LogLevel.DEBUG, {
  isOnGoogleCloud: () => false,
  forceStructuredLogging: () => false,
});

// Provide stubs for slack loggers if needed on client, or omit them
export class StubLogger {
  debug() {
    // No-op on client
  }
  info() {
    // No-op on client
  }
  warn() {
    // No-op on client
  }
  error() {
    // No-op on client
  }
}

export const slackLogger = new StubLogger();
export const slackClientLogger = new StubLogger();
export const slackBotClientLogger = new StubLogger();
