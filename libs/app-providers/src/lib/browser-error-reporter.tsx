'use client';

import { installBrowserErrorReporter } from '@members/logging/browser';
import { useEffect } from 'react';

export interface BrowserErrorReporterProps {
  /**
   * GCP trace id (from the `x-cloud-trace-context` request header) used to
   * correlate forwarded client errors with their request log. Optional —
   * reporting still works without it.
   */
  traceId?: string;
}

/**
 * Mounts global browser error capture once on the client and forwards errors to
 * /api/logs/error (Cloud Logging). Render once near the top of each app's root
 * layout. Renders nothing.
 */
export function BrowserErrorReporter({ traceId }: BrowserErrorReporterProps) {
  useEffect(() => installBrowserErrorReporter({ traceId }), [traceId]);
  return null;
}
