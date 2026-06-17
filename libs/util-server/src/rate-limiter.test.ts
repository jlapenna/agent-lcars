import { logger } from '@members/logging';
import Bottleneck from 'bottleneck';

import * as env from './env';
import {
  createProviderLimiter,
  isRetryableError,
  throttledFetch,
} from './rate-limiter';

jest.mock('./env');
jest.mock('@members/logging');
jest.mock('bottleneck');

describe('rate-limiter', () => {
  const mockedEnv = env as jest.Mocked<typeof env>;
  const mockedLogger = logger as jest.Mocked<typeof logger>;
  const MockedBottleneck = Bottleneck as unknown as jest.Mock;

  let mockLimiterInstance: {
    schedule: jest.Mock;
    on: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockLimiterInstance = {
      schedule: jest.fn(),
      on: jest.fn(),
    };

    MockedBottleneck.mockImplementation(() => mockLimiterInstance);

    mockedEnv.isTest.mockReturnValue(true);
    mockedEnv.getProviderMinRequestDelayMs.mockReturnValue(500);
    mockedEnv.getProviderRequestTimeoutMs.mockReturnValue(30000);
  });

  describe('isRetryableError', () => {
    it('should return true for status 429', () => {
      expect(isRetryableError({ status: 429 })).toBe(true);
    });

    it('should return true for status 5xx', () => {
      expect(isRetryableError({ status: 500 })).toBe(true);
      expect(isRetryableError({ status: 503 })).toBe(true);
      expect(isRetryableError({ status: 599 })).toBe(true);
    });

    it('should return false for status 4xx (except 429)', () => {
      expect(isRetryableError({ status: 400 })).toBe(false);
      expect(isRetryableError({ status: 404 })).toBe(false);
    });

    it('should return true for error code ECONNRESET', () => {
      expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    });

    it('should return true for error code ETIMEDOUT', () => {
      expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    it('should return true for error name FetchError', () => {
      expect(isRetryableError({ name: 'FetchError' })).toBe(true);
    });

    it('should return true for aborted/timed-out requests', () => {
      // AbortSignal.timeout() rejects with TimeoutError; manual abort -> AbortError.
      expect(isRetryableError({ name: 'TimeoutError' })).toBe(true);
      expect(isRetryableError({ name: 'AbortError' })).toBe(true);
    });

    it('should return true for error with cause code ECONNRESET', () => {
      expect(isRetryableError({ cause: { code: 'ECONNRESET' } })).toBe(true);
    });

    it('should return false for non-retryable errors', () => {
      expect(isRetryableError({ code: 'SOME_OTHER_ERROR' })).toBe(false);
      expect(isRetryableError(new Error('test'))).toBe(false);
    });

    it('should return false for non-object inputs', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
      expect(isRetryableError('error')).toBe(false);
      expect(isRetryableError(123)).toBe(false);
    });
  });

  describe('createProviderLimiter', () => {
    it('should return a test limiter when isTest() is true', () => {
      mockedEnv.isTest.mockReturnValue(true);

      const limiter = createProviderLimiter();

      expect(MockedBottleneck).toHaveBeenCalledWith({
        minTime: 0,
        maxConcurrent: null,
      });
      expect(limiter).toBe(mockLimiterInstance);
    });

    it('should return a real limiter when isTest() is false', () => {
      mockedEnv.isTest.mockReturnValue(false);
      mockedEnv.getProviderMinRequestDelayMs.mockReturnValue(500);

      const limiter = createProviderLimiter();

      expect(MockedBottleneck).toHaveBeenCalledWith({
        minTime: 500,
        maxConcurrent: 1,
      });
      expect(limiter).toBe(mockLimiterInstance);
    });

    describe('retry logic (failed handler)', () => {
      let failedHandler: (error: any, jobInfo: any) => Promise<number | null>;

      beforeEach(() => {
        mockedEnv.isTest.mockReturnValue(false);
        createProviderLimiter();
        // Capture the handler registered with .on('failed', ...)
        const calls = mockLimiterInstance.on.mock.calls;
        const failedCall = calls.find((call) => call[0] === 'failed');
        failedHandler = failedCall ? failedCall[1] : undefined;
      });

      it('should register a failed handler', () => {
        expect(failedHandler).toBeDefined();
        expect(failedHandler).toEqual(expect.any(Function));
      });

      it('should return correct exponential backoff for retryable errors', async () => {
        const error = { status: 429 };

        // Retry 0 -> 1000ms
        const delay0 = await failedHandler(error, { retryCount: 0 });
        expect(delay0).toBe(1000);
        expect(mockedLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Retrying in 1000ms'),
        );

        // Retry 1 -> 2000ms
        const delay1 = await failedHandler(error, { retryCount: 1 });
        expect(delay1).toBe(2000);

        // Retry 2 -> 4000ms
        const delay2 = await failedHandler(error, { retryCount: 2 });
        expect(delay2).toBe(4000);
      });

      it('should return null (stop retrying) if retry count is >= 3', async () => {
        const error = { status: 429 };
        const result = await failedHandler(error, { retryCount: 3 });
        expect(result).toBeNull();
      });

      it('should return null (stop retrying) for non-retryable errors', async () => {
        const error = { status: 400 };
        const result = await failedHandler(error, { retryCount: 0 });
        expect(result).toBeNull();
      });
    });
  });

  describe('throttledFetch', () => {
    let limiter: Bottleneck;

    beforeEach(() => {
      // Create a mock limiter instance for these tests
      limiter = new Bottleneck({ minTime: 0 });
      // Mock schedule to execute the callback immediately
      (limiter.schedule as jest.Mock).mockImplementation((fn) => fn());
      global.fetch = jest.fn();
    });

    it('should call fetch and return response on success', async () => {
      const mockResponse = { status: 200 } as Response;
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      const result = await throttledFetch(limiter, 'http://example.com');

      expect(result).toBe(mockResponse);
      // A timeout signal is attached so an unresponsive host can't hang forever.
      expect(global.fetch).toHaveBeenCalledWith(
        'http://example.com',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(limiter.schedule).toHaveBeenCalled();
    });

    it('uses a caller-supplied signal instead of the default timeout', async () => {
      const mockResponse = { status: 200 } as Response;
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);
      const controller = new AbortController();

      await throttledFetch(limiter, 'http://example.com', {
        signal: controller.signal,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://example.com',
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('should throw error with status for 429 response', async () => {
      const mockResponse = { status: 429 } as Response;
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      let error: any;
      try {
        await throttledFetch(limiter, 'http://example.com');
      } catch (e) {
        error = e;
      }
      expect(error.message).toBe('Request failed with status 429');
      expect(error.status).toBe(429);
    });

    it('should throw error with status for 5xx response', async () => {
      const mockResponse = { status: 500 } as Response;
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await expect(
        throttledFetch(limiter, 'http://example.com'),
      ).rejects.toThrow('Request failed with status 500');
    });

    it('should NOT throw custom error for 4xx (except 429) response', async () => {
      const mockResponse = { status: 404 } as Response;
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      const result = await throttledFetch(limiter, 'http://example.com');
      expect(result).toBe(mockResponse);
    });
  });
});
