import { logger } from '@members/logging';
import Bottleneck from 'bottleneck';

import { getProviderMinRequestDelayMs, isTest } from './env';

export function createProviderLimiter(): Bottleneck {
  if (isTest()) {
    // In test environment, return a limiter with no delay
    return new Bottleneck({
      minTime: 0,
      maxConcurrent: null, // Unlimited
    });
  }

  const limiter = new Bottleneck({
    minTime: getProviderMinRequestDelayMs(),
    maxConcurrent: 1, // Be polite, 1 concurrent request per domain instance
  });

  // Configure retries
  limiter.on('failed', async (error, jobInfo) => {
    if (jobInfo.retryCount < 3) {
      // Max 3 retries
      // Check if error is retryable (429 or 5xx)
      if (isRetryableError(error)) {
        const delay = 1000 * Math.pow(2, jobInfo.retryCount); // Exponential backoff: 1s, 2s, 4s
        logger.warn(
          `Request failed. Retrying in ${delay}ms. Retry count: ${jobInfo.retryCount}. Error: ${error}`,
        );
        return delay;
      }
    }
    return null; // Stop retrying
  });

  return limiter;
}

export function isRetryableError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const e = error as {
    status?: number;
    code?: string;
    name?: string;
    cause?: { code?: string };
  };
  if (
    e.status === 429 ||
    (e.status !== undefined && e.status >= 500 && e.status < 600)
  ) {
    return true;
  }
  // Network errors
  if (
    e.code === 'ECONNRESET' ||
    e.code === 'ETIMEDOUT' ||
    e.name === 'FetchError' ||
    e.cause?.code === 'ECONNRESET' // Node fetch often wraps cause
  ) {
    return true;
  }
  return false;
}

export async function throttledFetch(
  limiter: Bottleneck,
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  return limiter.schedule(async () => {
    const response = await fetch(url, init);

    if (response.status === 429 || response.status >= 500) {
      const error = new Error(
        `Request failed with status ${response.status}`,
      ) as Error & { status: number };
      error.status = response.status;
      throw error;
    }

    return response;
  });
}
