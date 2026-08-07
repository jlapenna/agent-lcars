import { reportServerError } from '@agent-lcars/logging/error-reporting';
import { initNodeLogging } from '@agent-lcars/logging/server';
import type { Instrumentation } from 'next';

export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    initNodeLogging();
  }
}

/**
 * Forwards server-side exceptions to Cloud Logging — the server-side
 * counterpart to the client BrowserErrorReporter.
 */
export const onRequestError: Instrumentation.onRequestError = (
  err,
  request,
  context,
) => reportServerError(err, request, context);
