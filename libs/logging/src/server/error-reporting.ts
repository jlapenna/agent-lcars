import 'server-only';

import { logger } from '../instance';

/**
 * Shared error-reporting helpers used by every Next.js app to land both client
 * and server errors in Cloud Logging as structured ERROR entries via the shared
 * `logger`. The app supplies its own `projectId` (resolved through its env
 * accessor) so this library does not depend on `@members/util-server` — that
 * would be circular, since util-server depends on `@members/logging`.
 */

interface ClientErrorReport {
  source?: string;
  message?: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  traceId?: string;
}

const CLIENT_PREFIX_BY_SOURCE: Record<string, string> = {
  'console.error': 'Browser Console Error:',
  'window.onerror': 'Uncaught Browser Error:',
  unhandledrejection: 'Unhandled Promise Rejection:',
};

const tracePath = (
  projectId: string | undefined,
  traceId: string | undefined,
): string | undefined =>
  projectId && traceId
    ? `projects/${projectId}/traces/${traceId}`
    : undefined;

/**
 * Handles a POST to /api/logs/error from the client `installBrowserErrorReporter`.
 * Each app's route is a thin wrapper that supplies its project id.
 */
export async function handleClientErrorReport(
  req: Request,
  options: { projectId?: string } = {},
): Promise<Response> {
  try {
    const { source, message, stack, url, userAgent, traceId } =
      (await req.json()) as ClientErrorReport;

    const prefix =
      (source && CLIENT_PREFIX_BY_SOURCE[source]) ?? 'Browser Error:';
    const trace = tracePath(options.projectId, traceId);

    logger.error({
      message: `${prefix} ${message ?? 'Unknown browser error'}`,
      ...(trace && { 'logging.googleapis.com/trace': trace }),
      clientData: { source, stack, url, userAgent },
    });

    return Response.json({ success: true });
  } catch (err) {
    logger.error({ message: 'Failed to process client-side error report', err });
    return Response.json(
      { success: false, error: 'Failed to process error' },
      { status: 500 },
    );
  }
}

// Structural subsets of Next's Instrumentation.onRequestError args, so this
// library does not need to depend on `next`. The app's instrumentation.ts holds
// the real `Instrumentation.onRequestError` type and passes these through.
interface ServerErrorRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

interface ServerErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
  renderSource?: string;
}

/**
 * Reports a server-side exception (server action, RSC render, route handler,
 * middleware) captured by Next's `onRequestError` instrumentation hook.
 */
export async function reportServerError(
  err: unknown,
  request: ServerErrorRequest,
  context: ServerErrorContext,
  options: { projectId?: string } = {},
): Promise<void> {
  const error = err as Partial<Error> & { digest?: string };

  // x-cloud-trace-context: TRACE_ID/SPAN_ID;o=TRACE_TRUE
  const traceHeader = request.headers?.['x-cloud-trace-context'];
  const rawTrace = Array.isArray(traceHeader) ? traceHeader[0] : traceHeader;
  const trace = tracePath(options.projectId, rawTrace?.split('/')[0]);

  logger.error({
    message: `Server Error: ${error?.message ?? String(err)}`,
    ...(trace && { 'logging.googleapis.com/trace': trace }),
    serverData: {
      digest: error?.digest,
      stack: error?.stack,
      path: request.path,
      method: request.method,
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
    },
  });
}
