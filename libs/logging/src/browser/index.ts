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

const ERROR_REPORT_ENDPOINT = '/api/logs/error';
const DEDUPE_WINDOW_MS = 10_000;
const MAX_MESSAGE_LENGTH = 2048;

interface ReporterWindow extends Window {
  __ERROR_REPORTER_INSTALLED__?: boolean;
  GCP_TRACE_ID?: string;
}

/**
 * Installs global browser error capture and forwards everything to
 * `/api/logs/error` so it lands in Cloud Logging. Captures three sources that
 * otherwise only appear in the browser console:
 *   - console.error (incl. React hydration errors and third-party libs)
 *   - uncaught exceptions (window 'error')
 *   - unhandled promise rejections
 *
 * Framework-agnostic; call once on the client. Returns a cleanup function that
 * restores console.error and removes the listeners. Safe to call repeatedly —
 * subsequent calls are no-ops until the previous install is cleaned up.
 */
export function installBrowserErrorReporter(
  options: { traceId?: string } = {},
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const w = window as ReporterWindow;
  if (options.traceId) {
    w.GCP_TRACE_ID = options.traceId;
  }

  // Guard against double-install (e.g. Fast Refresh / Strict Mode remounts).
  if (w.__ERROR_REPORTER_INSTALLED__) return () => undefined;
  w.__ERROR_REPORTER_INSTALLED__ = true;

  const recent = new Set<string>();
  const isDuplicate = (key: string): boolean => {
    if (recent.has(key)) return true;
    recent.add(key);
    setTimeout(() => recent.delete(key), DEDUPE_WINDOW_MS);
    return false;
  };

  // Reentrancy lock: if reporting an error itself triggers console.error,
  // don't recurse back into the proxy.
  let isReporting = false;

  const context = () => ({
    url: window.location.href,
    userAgent: navigator.userAgent,
    traceId: typeof w.GCP_TRACE_ID === 'string' ? w.GCP_TRACE_ID : undefined,
  });

  const report = (payload: Record<string, unknown>) => {
    isReporting = true;
    try {
      fetch(ERROR_REPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      })
        .catch(() => {
          // Swallow: never surface reporting failures to the console.
        })
        .finally(() => {
          isReporting = false;
        });
    } catch {
      isReporting = false;
    }
  };

  const originalError = console.error;
  console.error = function (...args: unknown[]) {
    originalError.apply(console, args);
    if (isReporting) return;
    try {
      const err = args.find((a): a is Error => a instanceof Error);
      const message = args
        .map((a) =>
          typeof a === 'string'
            ? a
            : a instanceof Error
              ? (a.stack ?? a.message)
              : safeStringify(a),
        )
        .join(' ')
        .slice(0, MAX_MESSAGE_LENGTH);
      if (!message || isDuplicate(`console:${message}`)) return;
      report({
        source: 'console.error',
        message,
        stack: err?.stack,
        ...context(),
      });
    } catch {
      // Ignore serialization failures.
    }
  };

  const onError = (event: ErrorEvent) => {
    const message = String(event.message || event.error).slice(
      0,
      MAX_MESSAGE_LENGTH,
    );
    if (isDuplicate(`error:${message}`)) return;
    report({
      source: 'window.onerror',
      message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      ...context(),
    });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = (
      reason instanceof Error ? reason.message : String(reason)
    ).slice(0, MAX_MESSAGE_LENGTH);
    if (isDuplicate(`reject:${message}`)) return;
    report({
      source: 'unhandledrejection',
      message,
      stack: reason instanceof Error ? reason.stack : undefined,
      ...context(),
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    console.error = originalError;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    w.__ERROR_REPORTER_INSTALLED__ = false;
  };
}
