import 'server-only';

import { formatWithOptions } from 'node:util';

import { setLogFormatter } from '@jlapenna/fleet-runtime/logging';

/**
 * Initialize Node.js specific logging behavior.
 */
export function initNodeLogging() {
  // Set log formatter to use Node's util.formatWithOptions
  setLogFormatter((args) => formatWithOptions({ depth: 5 }, ...args));
}
