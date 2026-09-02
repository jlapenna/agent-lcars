import { reportServerError } from '@agent-lcars/logging/error-reporting';
import { initNodeLogging } from '@agent-lcars/logging/server';
import type { Instrumentation } from 'next';

import { validateDeploymentIdentity } from './lib/deployment';

export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    initNodeLogging();
    // Fail the boot with a clear message when a required deployment-identity
    // variable is unset, rather than on whichever request happens to touch
    // it first (#1731).
    validateDeploymentIdentity();
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
