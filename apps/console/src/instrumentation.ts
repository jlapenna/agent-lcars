import { reportServerError } from '@agent-lcars/logging/error-reporting';
import { initNodeLogging } from '@agent-lcars/logging/server';
import type { Instrumentation } from 'next';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // The App-key parser uses node:crypto; keep it out of edge instrumentation.
    const { validateStartupConfiguration } =
      // eslint-disable-next-line no-restricted-syntax -- Next.js runtime-specific instrumentation must load Node imports inside register().
      await import('./lib/startup-configuration');
    initNodeLogging();
    // Fail the boot with a clear message when static deployment
    // configuration is missing or malformed, rather than on whichever
    // request happens to touch it first (#1731, #2033).
    validateStartupConfiguration();
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
