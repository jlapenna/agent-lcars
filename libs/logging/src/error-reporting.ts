/**
 * Shared, runtime-agnostic error reporting for the Next.js apps. Emits both
 * client-forwarded errors and server-side exceptions to Cloud Logging as
 * structured ERROR entries via a single-line `console.error(JSON…)`, which
 * App Hosting / Cloud Run parses into a structured entry (top-level severity +
 * trace).
 *
 * This module has NO node-only dependencies on purpose: it is imported by
 * `instrumentation.ts`, which Next compiles for the edge runtime whenever an
 * app ships an edge middleware (primes). Pulling the node `@repo/logging`
 * logger in here crashes the edge bundle (`__import_unsupported is not
 * defined`). `console.error` is safe in the Node and edge runtimes alike and,
 * unlike the logger, needs neither initNodeLogging() nor a LOG_LEVEL.
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

// Resolved from the environment so callers don't have to thread it through (and
// so this stays free of the node-only @repo/util-server accessor, which
// would be both a circular dep and edge-unsafe).
const getProjectId = (): string | undefined =>
  process.env.NEXT_PUBLIC_PROJECT_ID ||
  process.env.PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT_ID;

const tracePath = (traceId: string | undefined): string | undefined => {
  const projectId = getProjectId();
  return projectId && traceId
    ? `projects/${projectId}/traces/${traceId}`
    : undefined;
};

// Single-line JSON → parsed into a structured Cloud Logging entry.
const emit = (entry: Record<string, unknown>): void => {
  console.error(JSON.stringify(entry));
};

/**
 * Handles a POST to /api/logs/error from the client `installBrowserErrorReporter`.
 * Each app's `app/api/logs/error/route.ts` re-exports `clientErrorReportRoute`
 * as `POST` directly (#2127) - no app-specific code needed at all.
 */
export async function handleClientErrorReport(req: Request): Promise<Response> {
  try {
    const { source, message, stack, url, userAgent, traceId } =
      (await req.json()) as ClientErrorReport;

    const prefix =
      (source && CLIENT_PREFIX_BY_SOURCE[source]) ?? 'Browser Error:';
    const trace = tracePath(traceId);

    emit({
      severity: 'ERROR',
      message: `${prefix} ${message ?? 'Unknown browser error'}`,
      ...(trace && { 'logging.googleapis.com/trace': trace }),
      clientData: { source, stack, url, userAgent },
    });

    return Response.json({ success: true });
  } catch (err) {
    emit({
      severity: 'ERROR',
      message: 'Failed to process client-side error report',
      error: err instanceof Error ? err.stack : String(err),
    });
    return Response.json(
      { success: false, error: 'Failed to process error' },
      { status: 500 },
    );
  }
}

/** Ready-made Next.js route handler; see `handleClientErrorReport` above. */
export const clientErrorReportRoute = (req: Request): Promise<Response> =>
  handleClientErrorReport(req);

// Structural subsets of Next's Instrumentation.onRequestError args, so this
// library does not depend on `next`. The app's instrumentation.ts holds the
// real `Instrumentation.onRequestError` type and passes these through.
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
export function reportServerError(
  err: unknown,
  request: ServerErrorRequest,
  context: ServerErrorContext,
): void {
  const error = err as Partial<Error> & { digest?: string };

  // x-cloud-trace-context: TRACE_ID/SPAN_ID;o=TRACE_TRUE
  const traceHeader = request.headers?.['x-cloud-trace-context'];
  const rawTrace = Array.isArray(traceHeader) ? traceHeader[0] : traceHeader;
  const trace = tracePath(rawTrace?.split('/')[0]);

  emit({
    severity: 'ERROR',
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
