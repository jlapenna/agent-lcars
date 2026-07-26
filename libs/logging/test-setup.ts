import { AsyncLocalStorage } from 'node:async_hooks';

import { injectLoggingContext, RequestContext } from './src/context';

const contextStorage = new AsyncLocalStorage<RequestContext>();

// Inject real implementation for tests
injectLoggingContext(
  (context, callback) => contextStorage.run(context, callback),
  () => contextStorage.getStore(),
);
