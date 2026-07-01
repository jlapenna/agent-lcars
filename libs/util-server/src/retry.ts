import { logger } from '@repo/logging';

/**
 * Options for the retry utility.
 */
export interface RetryOptions {
  /** Maximum number of retries. Default: 3 */
  retries?: number;
  /** Initial delay in milliseconds. Default: 1000 */
  minTimeout?: number;
  /** Factor to multiply the delay by after each attempt. Default: 2 */
  factor?: number;
  /** Optional function to determine if an error should trigger a retry */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Retries an async operation with exponential backoff.
 *
 * @template T The return type of the operation
 * @param operation The async function to retry
 * @param options Configuration options
 * @returns The result of the operation
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 3,
    minTimeout = 1000,
    factor = 2,
    shouldRetry = () => true,
  } = options;

  let attempt = 0;
  let delay = minTimeout;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) {
        throw error;
      }

      attempt++;
      logger.warn(
        `Operation failed, retrying (attempt ${attempt}/${retries}): ${error instanceof Error ? error.message : String(error)}`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= factor;
    }
  }
}
