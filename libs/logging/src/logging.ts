import { logger } from './instance';

export * from './console-logger';
export * from './context';
export * from './instance'; // Export logger instances
export * from './log-level';
export * from './utils';

export function logMemory(tag = ''): void {
  logger.debug(getMemoryString(tag));
}

export function getMemoryString(tag = ''): string {
  if (
    typeof process === 'undefined' ||
    typeof process.memoryUsage !== 'function'
  ) {
    return `${tag ? `${tag}: ` : ''}Memory: N/A (Browser)`;
  }
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  return `${tag ? `${tag}: ` : ''}Memory: ${Math.floor(used)} MB`;
}
