import { RequestContext } from './context-types';

export * from './context-types';

let runWithContextImpl = <T>(_context: RequestContext, callback: () => T): T =>
  callback();
let getContextImpl = (): RequestContext | undefined => undefined;

/**
 * Injects the implementation for request context.
 * This is used to provide Node.js specific implementations (like AsyncLocalStorage)
 * without pulling them into client-side bundles.
 */
export function injectLoggingContext(
  run: typeof runWithContextImpl,
  get: typeof getContextImpl,
) {
  runWithContextImpl = run;
  getContextImpl = get;
}

export function runWithContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return runWithContextImpl(context, callback);
}

export function getContext(): RequestContext | undefined {
  return getContextImpl();
}
