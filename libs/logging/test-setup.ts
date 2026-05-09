import 'whatwg-fetch';

import { AsyncLocalStorage } from 'node:async_hooks';

import type { NextFunction, Request, Response } from 'express';

import { injectLoggingContext, RequestContext } from './src/context';

const contextStorage = new AsyncLocalStorage<RequestContext>();

// Inject real implementations for tests
injectLoggingContext(
  (context, callback) => contextStorage.run(context, callback),
  () => contextStorage.getStore(),
  (_req: Request, _res: Response, next: NextFunction) => next(),
  () => undefined,
);
