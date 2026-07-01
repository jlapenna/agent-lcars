import { injectLoggingContext, RequestContext } from '@repo/logging';
import { headers } from 'next/headers';

/**
 * Initializes the shared logging context for Next.js server-side code (RSC and Server Actions).
 * This allows trace IDs and other context to be automatically propagated to downstream services.
 */
export function initWebLogging() {
  injectLoggingContext(
    // run: We don't have a direct way to wrap the request in Next.js without a custom server,
    // so we provide a no-op for 'run' as we rely on Next.js's internal request context.
    <T>(_context: RequestContext, callback: () => T): T => callback(),

    // get: Simplified context for RSC
    () => undefined,

    // middleware: No-op for Next.js as it uses different middleware patterns
    () => {
      /* no-op */
    },

    // getTraceId: Pull directly from Next.js headers
    async () => {
      try {
        const headerList = await headers();
        const traceHeader = headerList.get('x-cloud-trace-context');
        if (traceHeader) {
          // Return the trace ID part (before the /)
          return traceHeader.split('/')[0];
        }
      } catch {
        // headers() throws if called outside of a request context
      }
      return undefined;
    },
  );
}
