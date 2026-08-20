import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { formatWithOptions } from 'node:util';

import {
  setLogEnricher,
  setLogFormatter,
} from '@jlapenna/fleet-runtime/logging';

import {
  getContext,
  injectLoggingContext,
  RequestContext,
  runWithContext,
} from '../context';

export { getContext, runWithContext };
export type { RequestContext };

const contextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Initialize Node.js specific logging context.
 */
export function initNodeLogging() {
  // Set log formatter to use Node's util.formatWithOptions
  setLogFormatter((args) => formatWithOptions({ depth: 5 }, ...args));

  // Inject context implementation
  injectLoggingContext(
    (context, callback) => contextStorage.run(context, callback),
    () => contextStorage.getStore(),
  );

  // Set log enricher for structured logging
  setLogEnricher(() => {
    const context = contextStorage.getStore();
    return {
      requestUrl: context?.path,
      userId: context?.userId,
      action: context?.action,
    };
  });
}
